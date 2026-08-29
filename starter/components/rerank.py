from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence

from .models import SearchPlan, SessionState
from .parser import COLOR_TERMS, MATERIAL_TERMS
from .snippets import tokens as snippet_tokens

CANDIDATE_POOL_SIZE = 150
BUDGET_RE = re.compile(r"(maximum|around)\s+\$(\d+(?:\.\d+)?)", re.IGNORECASE)
TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")

_FIELD_WEIGHTS = {
    "title": 5.0,
    "categories": 3.0,
    "features": 2.5,
    "details": 2.0,
    "store": 1.5,
    "description": 1.0,
}
# Weight of one fully-covered clue. Flat between ~5 and ~12 on the public set;
# above that the coverage term starts drowning the structured signals.
_COVERAGE_WEIGHT = 6.0
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


def _canonical(text: str) -> str:
    """Punctuation-free, space-padded form: ' fabric type 100 cotton '.

    The customer echoes the target's own ``features`` / ``details`` strings, but
    the evaluator renders a detail as ``"key: value"`` while our field map
    flattens it to ``"key value"`` -- a plain substring test misses on the
    punctuation alone. Padding both sides keeps the match on token boundaries
    ("cotton" must not match "cottonwood").
    """
    return " " + NON_ALNUM_RE.sub(" ", text).strip() + " "


def _phrase_score(fields: Mapping[str, str], phrases: Sequence[str]) -> float:
    if not phrases:
        return 0.0
    title = _canonical(fields["title"])
    strong = _canonical(_combined_text(fields, "categories", "features", "details"))
    description = _canonical(fields["description"])
    score = 0.0
    for phrase in phrases:
        needle = _canonical(phrase)
        if needle == "  ":
            continue
        if needle in title:
            score += 5.0
        elif needle in strong:
            score += 2.5
        elif needle in description:
            score += 1.0
    return score


def _snippet_coverage(fields: Mapping[str, str], snippets: Sequence[str]) -> float:
    """Per-clue token coverage -- partial credit where ``_phrase_score`` is all-or-nothing.

    A disclosed constraint is truncated at 180 characters and may be split
    mid-word, so the exact phrase often misses even on the target. Scoring each
    clue by the share of its tokens present keeps the evidence *per clue*, unlike
    ``_token_overlap``, where one long clue's tokens drown out the others.
    """
    if not snippets:
        return 0.0
    strong = _tokens(_combined_text(fields, "title", "categories", "features", "details"))
    if not strong:
        return 0.0
    score = 0.0
    for snippet in snippets:
        terms = snippet_tokens(snippet)
        if not terms:
            continue
        score += _COVERAGE_WEIGHT * sum(1 for term in terms if term in strong) / len(terms)
    return score


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


def _feedback_penalty(parent_asin: str, state: SessionState) -> float:
    if not state.parsed_messages:
        return 0.0
    last = state.parsed_messages[-1]
    if not (last.generic_feedback or last.override):
        return 0.0
    try:
        rank = state.last_recommendations.index(parent_asin)
    except ValueError:
        return 0.0
    return 1.5 - (0.1 * rank)


def _override_boost(state: SessionState) -> float:
    """Weight the freshest (post-override) exact-phrase signal more heavily.

    plan.exact_phrases is already scoped to text since the last override
    (search_plan.exact_phrases_for_state), so this only amplifies terms the
    customer just gave as their replacement intent -- not stale ones.
    """
    if state.parsed_messages and state.parsed_messages[-1].override:
        return 1.5
    return 1.0


def score_product(
    product: Mapping[str, object],
    state: SessionState,
    plan: SearchPlan,
    retrieval_score: float = 0.0,
) -> float:
    fields = _field_map(product)
    unconstrained = state.unconstrained_attributes
    # Snippet terms carry what the parser drops ("jersey", "tagless", "4.3 oz"),
    # i.e. the tokens retrieval actually matched on.
    query_terms = list(dict.fromkeys([
        *plan.required_terms,
        *plan.snippet_terms,
        *plan.optional_terms,
    ]))
    return (
        retrieval_score
        + _override_boost(state) * _phrase_score(fields, plan.exact_phrases)
        + _snippet_coverage(fields, plan.exact_phrases)
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
    scored: dict[str, float] = {}
    for candidate in candidates:
        parent_asin = str(candidate.get("parent_asin", "")).strip()
        if not parent_asin:
            continue
        product = catalog.get(parent_asin, candidate)
        retrieval = candidate.get("retrieval_score", 0.0)
        retrieval_score = float(retrieval) if isinstance(retrieval, (int, float)) else 0.0
        total = score_product(product, state, active_plan, retrieval_score)
        previous = scored.get(parent_asin)
        if previous is None or total > previous:
            scored[parent_asin] = total
    return [
        parent_asin
        for parent_asin, _score in sorted(scored.items(), key=lambda item: (-item[1], item[0]))
    ]
