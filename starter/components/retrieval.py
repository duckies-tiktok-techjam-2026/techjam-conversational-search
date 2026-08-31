"""Candidate pool generation.

Owns: the FTS5 index + document-frequency table (built once in ``__init__``) and
``get_candidates`` — a multi-path union that returns ~150-300 ``parent_asin`` whose
only job is to *contain the target*. Ordering is loose; ranking is a separate step.
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .models import SessionState
from .snippets import category_from_opener, disclosure_snippets, tokens as _tokens

# FTS5 columns, in order. parent_asin is UNINDEXED but still counts as a column
# for bm25() weights, so it gets a 0.0 slot.
_BM25_WEIGHTS = "0.0, 8.0, 5.0, 3.0, 3.0, 1.0, 0.5"

_MAX_SNIPPETS = 8

# Raw BM25 scores are not comparable across paths: a short, generic OR query
# (e.g. "category") concentrates BM25's IDF term over fewer words and can
# numerically outscore a candidate that satisfied a tighter, multi-clause AND
# (e.g. "core") even though the AND is much stronger evidence of relevance.
# Tiering paths by specificity before comparing scores keeps a genuine
# conjunctive match from being evicted from the pool by a loosely-matched
# broad-recall candidate. See README.md for the rationale.
_PATH_TIER = {"core": 2, "rare_and": 2, "structured": 1, "category": 0, "bm25_all": 0}


@dataclass
class Candidate:
    parent_asin: str
    paths: set[str] = field(default_factory=set)
    fts_score: float = 0.0


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(f"{key} {item}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value)


class CandidateIndex:
    def __init__(self, catalog_path: str | Path = "data/catalog.jsonl") -> None:
        self.connection = sqlite3.connect(":memory:")
        self.df: Counter[str] = Counter()
        self.doc_count = 0
        self._build_index(Path(catalog_path))

    def _build_index(self, catalog_path: Path) -> None:
        cursor = self.connection.cursor()
        cursor.execute(
            "CREATE VIRTUAL TABLE products USING fts5("
            "parent_asin UNINDEXED, title, categories, features, details, description, store, "
            "tokenize='unicode61 remove_diacritics 2')"
        )
        batch: list[tuple] = []
        with catalog_path.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                product = json.loads(line)
                row = (
                    str(product["parent_asin"]),
                    _text(product.get("title")),
                    _text(product.get("categories")),
                    _text(product.get("features")),
                    _text(product.get("details")),
                    _text(product.get("description")),
                    _text(product.get("store")),
                )
                batch.append(row)
                self.doc_count += 1
                for token in set(_tokens(" ".join(row[1:]))):
                    self.df[token] += 1
                if len(batch) >= 1000:
                    cursor.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
                    batch.clear()
        if batch:
            cursor.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
        self.connection.commit()

    # ------------------------------------------------------------------ helpers

    def _match(self, expression: str, limit: int) -> list[tuple[str, float]]:
        """Run one FTS5 query. Returns (parent_asin, score) with higher = better."""
        if not expression:
            return []
        try:
            rows = self.connection.execute(
                f"SELECT parent_asin, bm25(products, {_BM25_WEIGHTS}) AS s "
                "FROM products WHERE products MATCH ? ORDER BY s LIMIT ?",
                (expression, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        # bm25() is negative, more-negative = better; flip so bigger = better.
        return [(str(asin), -score) for asin, score in rows]

    def _rare_terms(self, snippet: str, k: int = 4) -> list[str]:
        # df == 0 means the token is nowhere in the catalog: keeping it would make
        # any AND it appears in unsatisfiable.
        seen = [token for token in dict.fromkeys(_tokens(snippet)) if self.df.get(token, 0)]
        return sorted(seen, key=lambda token: self.df[token])[:k]

    @staticmethod
    def _category_hint(state: SessionState) -> str:
        hint = getattr(state, "category_hint", None)
        if hint:
            return str(hint)
        messages = getattr(state, "messages", None) or []
        return category_from_opener(messages[0]) if messages else ""

    # -------------------------------------------------------------------- main

    def get_candidates(self, state: SessionState, pool_size: int = 200) -> list[Candidate]:
        pool: dict[str, Candidate] = {}

        def add(path: str, hits: list[tuple[str, float]]) -> None:
            for parent_asin, score in hits:
                candidate = pool.setdefault(parent_asin, Candidate(parent_asin))
                candidate.paths.add(path)
                candidate.fts_score = max(candidate.fts_score, score)

        # Snippets are verbatim customer text; structured values come from the
        # parser, which is reliable for the closed vocabularies it does cover.
        # They live in components/snippets.py because rerank scores against the
        # same text -- ranking on a thinner query than the one that found the
        # candidate is what buried correct hits mid-list.
        snippets = disclosure_snippets(state)
        structured = [
            constraint.value
            for attribute in ("material", "color", "brand")
            for constraint in state.positive_constraints.get(attribute, [])
        ]

        # Path A -- rare-term AND, one query per disclosed snippet. A long verbatim
        # snippet can AND its way to zero hits (truncated details, paraphrase), so
        # relax the conjunction before falling back to OR.
        for snippet in snippets[:_MAX_SNIPPETS]:
            terms = self._rare_terms(snippet, k=4)
            if not terms:
                continue
            hits: list[tuple[str, float]] = []
            for width in (4, 2):
                if width > len(terms):
                    continue
                hits = self._match(" AND ".join(f'"{t}"' for t in terms[:width]), 80)
                if len(hits) >= 5:
                    break
            # A single-term snippet (e.g. a bare override reply like "polyester")
            # never satisfies width <= len(terms) above, so it would otherwise
            # fall through with zero hits despite being a perfectly valid match.
            if len(hits) < 5:
                if len(terms) > 1:
                    hits = self._match(" OR ".join(f'"{t}"' for t in terms), 80)
                else:
                    hits = self._match(f'"{terms[0]}"', 80)
            add("rare_and", hits)

        # Path C -- conjunctive core: AND every known clue, relax if too strict.
        # Each clue is an OR of its own terms (tolerant to truncation / paraphrase);
        # clues are ANDed across each other and dropped least-selective-first.
        category = self._category_hint(state)
        clauses: list[tuple[float, str]] = []

        def clause(terms: list[str], weight: str = "sum") -> None:
            terms = list(dict.fromkeys(terms))
            if not terms:
                return
            dfs = [self.df.get(term, 1) for term in terms]
            selectivity = min(dfs) if weight == "min" else sum(dfs)
            clauses.append((selectivity, "(" + " OR ".join(f'"{t}"' for t in terms) + ")"))

        clause(_tokens(category))
        for snippet in snippets[:_MAX_SNIPPETS]:
            clause(self._rare_terms(snippet, k=3))
        for value in structured:
            clause(_tokens(value), weight="min")

        clauses.sort(key=lambda item: item[0])
        exprs = [expr for _, expr in clauses]
        while exprs:
            hits = self._match(" AND ".join(exprs), 150)
            if hits:
                add("core", hits)
                if len(hits) >= 8 or len(exprs) == 1:
                    break
            exprs.pop()

        # Path C-fallback -- broad OR, only carries turns with no usable clue.
        fallback_text = " ".join([getattr(state, "query_text", "") or "", *snippets])
        terms = list(dict.fromkeys(_tokens(fallback_text)))[:40]
        add("bm25_all", self._match(" OR ".join(f'"{t}"' for t in terms), 100))

        # Path D -- category + structured attribute includes.
        add("category", self._match(" OR ".join(f'"{t}"' for t in _tokens(category)), 80))
        for value in structured:
            value_terms = list(dict.fromkeys(_tokens(value)))
            add("structured", self._match(" OR ".join(f'"{t}"' for t in value_terms), 50))

        ordered = sorted(
            pool.values(),
            key=lambda candidate: (
                max(_PATH_TIER.get(path, 0) for path in candidate.paths),
                len(candidate.paths),
                candidate.fts_score,
            ),
            reverse=True,
        )
        return ordered[:pool_size]
