from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .components.parser import parse_message
from .components.questions import choose_question_attribute, question_text
from .components.rerank import CANDIDATE_POOL_SIZE, rerank
from .components.search_plan import build_search_plan
from .components.session_store import SessionStore


BM25_WEIGHTS = (0.0, 6.0, 4.0, 2.5, 2.5, 1.5, 1.0)


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(f"{key} {item}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value)


class Agent:
    """Stateful BM25 retrieval with structured constraint reranking."""

    def __init__(self, catalog_path: str | Path = "data/catalog.jsonl") -> None:
        self.catalog_path = Path(catalog_path)
        self.connection = sqlite3.connect(":memory:")
        self.session_store = SessionStore()
        self.products: dict[str, dict] = {}
        self._build_index()

    def _build_index(self) -> None:
        cursor = self.connection.cursor()
        cursor.execute(
            "CREATE VIRTUAL TABLE products USING fts5("
            "parent_asin UNINDEXED, title, categories, features, details, store, description, "
            "tokenize='unicode61 remove_diacritics 2')"
        )
        batch: list[tuple[str, str, str, str, str, str, str]] = []
        with self.catalog_path.open(encoding="utf-8") as handle:
            for line in handle:
                product = json.loads(line)
                parent_asin = str(product["parent_asin"])
                product["parent_asin"] = parent_asin
                self.products[parent_asin] = product
                batch.append(
                    (
                        parent_asin,
                        _text(product.get("title")),
                        _text(product.get("categories")),
                        _text(product.get("features")),
                        _text(product.get("details")),
                        _text(product.get("store")),
                        _text(product.get("description")),
                    )
                )
                if len(batch) >= 1000:
                    cursor.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
                    batch.clear()
        if batch:
            cursor.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
        self.connection.commit()

    def reset(self, session_id: str, user_profile: dict) -> None:
        self.session_store.reset(session_id, user_profile)

    def _retrieve_candidates(self, search_text: str) -> list[dict]:
        unique_terms = list(dict.fromkeys(parse_message(search_text).tokens))[:40]
        expression = " OR ".join(f'"{term}"' for term in unique_terms)
        if not expression:
            return []
        weights = ", ".join(str(weight) for weight in BM25_WEIGHTS)
        rows = self.connection.execute(
            f"SELECT parent_asin, bm25(products, {weights}) FROM products "
            "WHERE products MATCH ? "
            f"ORDER BY bm25(products, {weights}) LIMIT ?",
            (expression, CANDIDATE_POOL_SIZE),
        ).fetchall()
        candidates: list[dict] = []
        for parent_asin, bm25_rank in rows:
            # FTS5 bm25 is better when more negative; flip so rerank can treat higher as better.
            retrieval_score = 0.0 if bm25_rank is None else -float(bm25_rank)
            candidates.append(
                {
                    "parent_asin": str(parent_asin),
                    "retrieval_score": retrieval_score,
                }
            )
        return candidates

    def respond(
        self,
        session_id: str,
        user_message: str,
        turn: int,
        top_k: int,
    ) -> dict:
        state = self.session_store.get(session_id)
        parsed = parse_message(user_message)
        self.session_store.update(state, user_message, parsed)
        state.last_search_plan = build_search_plan(state)
        search_text = f"{state.query_text} {parsed.normalized_text}".strip()
        ranked = rerank(
            self._retrieve_candidates(search_text),
            state,
            state.last_search_plan,
            self.products,
        )
        recommendations = [{"parent_asin": parent_asin} for parent_asin in ranked[:top_k]]
        state.last_recommendations = [item["parent_asin"] for item in recommendations]
        ask_attribute = choose_question_attribute(state, turn)
        self.session_store.mark_question(state, ask_attribute)
        return {
            "message": question_text(ask_attribute),
            "ask_attribute": ask_attribute,
            "recommendations": recommendations,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }
