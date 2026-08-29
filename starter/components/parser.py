from __future__ import annotations

import re

from .models import Constraint, ParsedMessage


TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
    "am", "i", "in", "is", "it", "me", "my", "of", "on", "or", "please", "some",
    "that", "the", "this", "to", "want", "with", "would", "you", "looking",
}
MATERIAL_TERMS = ("cotton", "polyester", "nylon", "leather", "wool", "spandex", "silk", "rayon", "fabric")
COLOR_TERMS = ("black", "white", "blue", "red", "pink", "green", "brown", "gray", "grey", "purple", "yellow", "orange")
USE_CASE_TERMS = ("hiking", "running", "gym", "winter", "outdoor", "work")
SIZE_TERMS = ("small", "medium", "large", "wide", "narrow")
CATEGORY_TERMS = (
    "boots", "shoes", "sneakers", "sandals", "dress", "shirt", "jacket", "coat",
    "pants", "jeans", "shorts", "socks", "hat", "belt", "bag", "purse", "watch",
    "gloves", "swimsuit", "underwear",
)
STYLE_TERMS = (
    "casual", "formal", "athletic", "vintage", "classic", "slim", "relaxed", "loose",
    "fitted", "minimalist",
)
FEATURE_TERMS = (
    "waterproof", "water-resistant", "breathable", "insulated", "non-slip", "comfortable",
    "durable", "warm", "lightweight", "pockets", "support", "adjustable",
)
OVERRIDE_PHRASES = (
    "actually",
    "instead",
    "ignore my earlier preference",
    "changed my mind",
    "what i need is",
    "rather than",
)
BOUNDARY_PHRASES = (
    "no preference",
    "don't care",
    "use your judgment",
    "anything is fine",
    "doesn't matter",
)
FEEDBACK_PHRASES = (
    "not quite right",
    "not what i want",
    "try again",
    "not right",
)


def _terms(text: str) -> list[str]:
    return [
        token.lower()
        for token in TOKEN_RE.findall(text)
        if len(token) > 1 and token.lower() not in STOPWORDS
    ]


def _contains_phrase(text: str, phrases: tuple[str, ...]) -> bool:
    return any(phrase in text for phrase in phrases)


def _extract_term_constraints(text: str, terms: tuple[str, ...], attribute: str) -> list[Constraint]:
    return [
        Constraint(attribute, term, "positive", 1.0)
        for term in terms
        if re.search(rf"\b{re.escape(term)}\b", text)
        and not re.search(rf"(?:no|without|not|do not want|don't want)\s+(?:any\s+)?{re.escape(term)}\b", text)
    ]


def _extract_budget_constraints(text: str) -> list[Constraint]:
    constraints: list[Constraint] = []
    matched_spans: list[tuple[int, int]] = []
    patterns = (
        (r"(?:under|below|less than|up to)\s+\$?\s*(\d+(?:\.\d+)?)", "maximum"),
        (r"\$\s*(\d+(?:\.\d+)?)", "around"),
    )
    for pattern, qualifier in patterns:
        for match in re.finditer(pattern, text):
            if any(match.start() < end and start < match.end() for start, end in matched_spans):
                continue
            matched_spans.append(match.span())
            value = f"{qualifier} ${match.group(1)}"
            constraints.append(Constraint("budget", value, "positive", 1.0))
    return constraints


def _extract_negative_constraints(text: str) -> list[Constraint]:
    constraints: list[Constraint] = []
    term_groups = (
        ("material", MATERIAL_TERMS),
        ("color", COLOR_TERMS),
        ("size", SIZE_TERMS),
        ("category", CATEGORY_TERMS),
        ("style", STYLE_TERMS),
        ("feature", FEATURE_TERMS),
    )
    for attribute, terms in term_groups:
        for term in terms:
            if re.search(rf"(?:no|without|not|do not want|don't want)\s+(?:any\s+)?{re.escape(term)}\b", text):
                constraints.append(Constraint(attribute, term, "negative", 1.0))
    return constraints


def _extract_brand_constraint(text: str) -> list[Constraint]:
    match = re.search(r"\bbrand\s+([a-z0-9][a-z0-9&'-]*(?:\s+[a-z0-9][a-z0-9&'-]*)?)", text)
    if not match:
        return []
    return [Constraint("brand", match.group(1), "positive", 0.9)]


def parse_message(text: str) -> ParsedMessage:
    normalized_text = re.sub(r"\s+", " ", str(text).strip().lower())
    constraints = [
        *_extract_term_constraints(normalized_text, MATERIAL_TERMS, "material"),
        *_extract_term_constraints(normalized_text, COLOR_TERMS, "color"),
        *_extract_term_constraints(normalized_text, USE_CASE_TERMS, "use_case"),
        *_extract_term_constraints(normalized_text, SIZE_TERMS, "size"),
        *_extract_term_constraints(normalized_text, CATEGORY_TERMS, "category"),
        *_extract_term_constraints(normalized_text, STYLE_TERMS, "style"),
        *_extract_term_constraints(normalized_text, FEATURE_TERMS, "feature"),
        *_extract_brand_constraint(normalized_text),
        *_extract_budget_constraints(normalized_text),
        *_extract_negative_constraints(normalized_text),
    ]
    unique_constraints: list[Constraint] = []
    seen: set[tuple[str, str, str]] = set()
    for constraint in constraints:
        key = (constraint.attribute, constraint.value, constraint.polarity)
        if key not in seen:
            seen.add(key)
            unique_constraints.append(constraint)
    return ParsedMessage(
        normalized_text=normalized_text,
        tokens=_terms(normalized_text),
        constraints=unique_constraints,
        override=_contains_phrase(normalized_text, OVERRIDE_PHRASES),
        boundary=_contains_phrase(normalized_text, BOUNDARY_PHRASES),
        generic_feedback=_contains_phrase(normalized_text, FEEDBACK_PHRASES),
    )
