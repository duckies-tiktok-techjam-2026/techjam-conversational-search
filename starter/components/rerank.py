from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence

from .models import SearchPlan, SessionState
from .parser import COLOR_TERMS, MATERIAL_TERMS

CANDIDATE_POOL_SIZE = 150

# Pool-local min-max prior over raw fts_score, scaled before entering score_product.
# Ablation (2026-08-29): minmax w=9 beat raw on Hit@10 (0.805 vs 0.790) and buying
# (0.787 vs 0.738). Phrase ablation: stripped exact_phrases + PHRASE_WEIGHT=2.0 at
# RETRIEVAL_WEIGHT=9 → Hit@10 0.850, MRR 0.489, Tech 0.710 (dead phrases: 0.805/0.405/0.652).
RETRIEVAL_PRIOR_MODE = "minmax"
RETRIEVAL_WEIGHT = 9.0
PHRASE_WEIGHT = 2.0
PRIOR_ONLY = False
RRF_K = 15

_BM25_PATH_WEIGHTS = {
    "rare_and": 3.0,
    "core": 2.0,
    "structured": 1.5,
    "category": 1.0,
    "bm25_all": 0.5,
}

BUDGET_RE = re.compile(r"(maximum|around)\s+\$(\d+(?:\.\d+)?)", re.IGNORECASE)
TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)

_FIELD_WEIGHTS = {
    "title": 5.0,
    "categories": 3.0,
    "features": 2.5,
    "details": 2.0,
    "store": 1.5,
    "description": 1.0,
}
_HARD_ATTRIBUTES = ("category", "material", "color", "size", "style", "brand", "feature", "use_case")


def _as_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(f"{key} {item}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value)


def _normalize(value: object) -> str:
    return re.sub(r"\s+", " ", _as_text(value).strip().lower())


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(text) if len(token) > 1}


def _field_map(product: Mapping[str, object]) -> dict[str, str]:
    return {
        "title": _normalize(product.get("title")),
        "categories": _normalize(product.get("categories")),
        "features": _normalize(product.get("features")),
        "details": _normalize(product.get("details")),
        "store": _normalize(product.get("store")),
        "description": _normalize(product.get("description")),
    }


def _combined_text(fields: Mapping[str, str], *names: str) -> str:
    return " ".join(fields[name] for name in names if fields.get(name))


def _contains(haystack: str, needle: str) -> bool:
    if not needle:
        return False
    if " " in needle:
        return needle in haystack
    return re.search(rf"\b{re.escape(needle)}\b", haystack) is not None


def _phrase_score(fields: Mapping[str, str], phrases: Sequence[str]) -> float:
    score = 0.0
    for phrase in phrases:
        if _contains(fields["title"], phrase):
            score += 5.0
        elif _contains(_combined_text(fields, "categories", "features", "details"), phrase):
            score += 2.5
        elif _contains(fields["description"], phrase):
            score += 1.0
    return score * PHRASE_WEIGHT


def _token_overlap(fields: Mapping[str, str], terms: Sequence[str]) -> float:
    query_tokens = [term.lower() for term in terms if term]
    if not query_tokens:
        return 0.0
    unique = list(dict.fromkeys(query_tokens))
    score = 0.0
    for field, weight in _FIELD_WEIGHTS.items():
        field_tokens = _tokens(fields[field])
        if not field_tokens:
            continue
        hits = sum(1 for token in unique if token in field_tokens)
        score += weight * (hits / len(unique))
    return score


def _attribute_score(
    fields: Mapping[str, str],
    plan: SearchPlan,
    unconstrained: set[str],
) -> float:
    blob = _combined_text(fields, "title", "categories", "features", "details", "store")
    description = fields["description"]
    score = 0.0
    for attribute, values in plan.attribute_values.items():
        if attribute in unconstrained:
            continue
        for value in values:
            if _contains(blob, value):
                score += 2.5 if attribute in _HARD_ATTRIBUTES else 1.5
            elif _contains(description, value):
                score += 0.75
            elif attribute in ("material", "color", "category"):
                score -= 1.5
    return score


def _optional_score(fields: Mapping[str, str], terms: Sequence[str]) -> float:
    blob = _combined_text(fields, "title", "categories", "features", "details", "description")
    return sum(0.4 for term in terms if _contains(blob, term))


def _contradiction_penalty(
    fields: Mapping[str, str],
    plan: SearchPlan,
    unconstrained: set[str],
) -> float:
    title = fields["title"]
    strong = _combined_text(fields, "title", "features", "details")
    description = fields["description"]
    penalty = 0.0
    for term in plan.excluded_terms:
        if _contains(title, term):
            penalty += 4.0
        elif _contains(strong, term):
            penalty += 2.5
        elif _contains(description, term):
            penalty += 1.0

    required_colors = [
        value
        for value in plan.attribute_values.get("color", [])
        if "color" not in unconstrained
    ]
    if required_colors:
        mentioned = [color for color in COLOR_TERMS if _contains(strong, color)]
        if mentioned and not any(color in mentioned for color in required_colors):
            penalty += 3.5

    required_materials = [
        value
        for value in plan.attribute_values.get("material", [])
        if "material" not in unconstrained
    ]
    if required_materials:
        mentioned = [material for material in MATERIAL_TERMS if _contains(strong, material)]
        if mentioned and not any(material in mentioned for material in required_materials):
            penalty += 3.5
    return penalty


def _budget_penalty(product: Mapping[str, object], plan: SearchPlan, unconstrained: set[str]) -> float:
    if "budget" in unconstrained:
        return 0.0
    price = product.get("price")
    if not isinstance(price, (int, float)):
        return 0.0
    penalty = 0.0
    for value in plan.attribute_values.get("budget", []):
        match = BUDGET_RE.search(value)
        if not match:
            continue
        amount = float(match.group(2))
        qualifier = match.group(1).lower()
        if qualifier == "maximum" and price > amount:
            penalty += 5.0 + min(4.0, (price - amount) / max(amount, 1.0))
        elif qualifier == "around":
            gap = abs(price - amount) / max(amount, 1.0)
            if gap > 0.35:
                penalty += 2.0 * gap
    return penalty


def _quality_tiebreak(product: Mapping[str, object]) -> float:
    rating = product.get("average_rating")
    count = product.get("rating_number")
    rating_value = float(rating) if isinstance(rating, (int, float)) else 0.0
    count_value = float(count) if isinstance(count, (int, float)) else 0.0
    return 0.05 * rating_value + 0.015 * math.log1p(max(count_value, 0.0))


def _raw_retrieval_score(candidate: Mapping[str, object]) -> float:
    retrieval = candidate.get("retrieval_score", 0.0)
    return float(retrieval) if isinstance(retrieval, (int, float)) else 0.0


def _retrieval_prior(candidates: Sequence[Mapping[str, object]]) -> dict[str, float]:
    """Map parent_asin -> bounded prior in [0, 1] for this pool."""
    mode = RETRIEVAL_PRIOR_MODE
    if mode == "none":
        return {}

    if mode == "rrf":
        fused: dict[str, float] = {}
        for candidate in candidates:
            parent_asin = str(candidate.get("parent_asin", "")).strip()
            if not parent_asin:
                continue
            ranks = candidate.get("path_ranks")
            if not isinstance(ranks, Mapping):
                continue
            score = 0.0
            for path, rank in ranks.items():
                if not isinstance(rank, int) or rank < 1:
                    continue
                weight = _BM25_PATH_WEIGHTS.get(str(path), 1.0)
                score += weight / (RRF_K + rank)
            if score > fused.get(parent_asin, 0.0):
                fused[parent_asin] = score
        if not fused:
            return {}
        max_score = max(fused.values())
        if max_score <= 0.0:
            return {parent_asin: 0.0 for parent_asin in fused}
        return {parent_asin: score / max_score for parent_asin, score in fused.items()}

    raw_by_asin: dict[str, float] = {}
    for candidate in candidates:
        parent_asin = str(candidate.get("parent_asin", "")).strip()
        if not parent_asin:
            continue
        raw = _raw_retrieval_score(candidate)
        previous = raw_by_asin.get(parent_asin)
        if previous is None or raw > previous:
            raw_by_asin[parent_asin] = raw

    if mode == "raw":
        return raw_by_asin

    if not raw_by_asin:
        return {}

    if mode == "pool_rank":
        ordered = sorted(raw_by_asin.items(), key=lambda item: (-item[1], item[0]))
        pool_size = len(ordered)
        if pool_size == 1:
            return {ordered[0][0]: 1.0}
        return {
            parent_asin: (pool_size - rank) / (pool_size - 1)
            for rank, (parent_asin, _score) in enumerate(ordered)
        }

    values = list(raw_by_asin.values())
    if mode == "log_minmax":
        transformed = {parent_asin: math.log1p(max(raw, 0.0)) for parent_asin, raw in raw_by_asin.items()}
        lo = min(transformed.values())
        hi = max(transformed.values())
        if hi <= lo:
            return {parent_asin: 1.0 for parent_asin in raw_by_asin}
        return {
            parent_asin: (value - lo) / (hi - lo)
            for parent_asin, value in transformed.items()
        }

    # minmax
    lo = min(values)
    hi = max(values)
    if hi <= lo:
        return {parent_asin: 1.0 for parent_asin in raw_by_asin}
    return {
        parent_asin: (raw - lo) / (hi - lo)
        for parent_asin, raw in raw_by_asin.items()
    }


def _feedback_penalty(parent_asin: str, state: SessionState) -> float:
    if not state.parsed_messages or not state.parsed_messages[-1].generic_feedback:
        return 0.0
    try:
        rank = state.last_recommendations.index(parent_asin)
    except ValueError:
        return 0.0
    return 1.5 - (0.1 * rank)


def score_product(
    product: Mapping[str, object],
    state: SessionState,
    plan: SearchPlan,
    retrieval_score: float = 0.0,
) -> float:
    """Score one product. ``retrieval_score`` is a pool-local prior in [0, 1]
    (already scaled by ``RETRIEVAL_WEIGHT`` when called from ``rerank``)."""
    if PRIOR_ONLY:
        return retrieval_score

    fields = _field_map(product)
    unconstrained = state.unconstrained_attributes
    query_terms = list(dict.fromkeys([*plan.required_terms, *plan.optional_terms]))
    return (
        retrieval_score
        + _phrase_score(fields, plan.exact_phrases)
        + _token_overlap(fields, query_terms)
        + _attribute_score(fields, plan, unconstrained)
        + _optional_score(fields, plan.optional_terms)
        + _quality_tiebreak(product)
        - _contradiction_penalty(fields, plan, unconstrained)
        - _budget_penalty(product, plan, unconstrained)
        - _feedback_penalty(str(product.get("parent_asin", "")), state)
    )


def rerank(
    candidates: Sequence[Mapping[str, object]],
    state: SessionState,
    plan: SearchPlan | None,
    products: Mapping[str, Mapping[str, object]] | None = None,
) -> list[str]:
    """Return unique parent_asin values, best first."""
    catalog = products or {}
    active_plan = plan or SearchPlan([], [], [], [], {})
    priors = _retrieval_prior(candidates)
    scored: dict[str, float] = {}
    for candidate in candidates:
        parent_asin = str(candidate.get("parent_asin", "")).strip()
        if not parent_asin:
            continue
        product = catalog.get(parent_asin, candidate)
        if RETRIEVAL_PRIOR_MODE == "raw":
            retrieval_score = _raw_retrieval_score(candidate)
        else:
            prior = priors.get(parent_asin, 0.0)
            retrieval_score = prior * RETRIEVAL_WEIGHT
        total = score_product(product, state, active_plan, retrieval_score)
        previous = scored.get(parent_asin)
        if previous is None or total > previous:
            scored[parent_asin] = total
    return [
        parent_asin
        for parent_asin, _score in sorted(scored.items(), key=lambda item: (-item[1], item[0]))
    ]
