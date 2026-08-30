from __future__ import annotations

from .models import SearchPlan, SessionState
from .snippets import disclosure_snippets, snippet_terms, snippet_weights


def build_search_plan(state: SessionState) -> SearchPlan:
    required_terms: list[str] = []
    excluded_terms: list[str] = []
    attribute_values: dict[str, list[str]] = {}

    for attribute, constraints in state.positive_constraints.items():
        if attribute in state.unconstrained_attributes:
            continue
        values = attribute_values.setdefault(attribute, [])
        for constraint in constraints:
            if constraint.value not in values:
                values.append(constraint.value)
                required_terms.append(constraint.value)

    for attribute, constraints in state.negative_constraints.items():
        if attribute in state.unconstrained_attributes:
            continue
        for constraint in constraints:
            if constraint.value not in excluded_terms:
                excluded_terms.append(constraint.value)

    optional_terms = list(dict.fromkeys(
        str(tag).strip().lower()
        for tag in state.user_profile.get("preference_tags", [])
        if str(tag).strip()
    ))
    exact_phrases = exact_phrases_for_state(state)

    return SearchPlan(
        required_terms=required_terms,
        optional_terms=optional_terms,
        excluded_terms=excluded_terms,
        exact_phrases=exact_phrases,
        attribute_values=attribute_values,
        snippet_terms=snippet_terms(exact_phrases),
        snippet_weights=snippet_weights(state, exact_phrases),
    )


def exact_phrases_for_state(state: SessionState) -> list[str]:
    """The same verbatim snippets retrieval searches on -- see components/snippets.py.

    Previously this returned the whole normalized turn text, boilerplate and all
    ("i'm looking for shirts. a key requirement is: ..."), which could never
    substring-match a product field, so the strongest positive signal in
    ``score_product`` was contributing nothing on most turns.
    """
    return disclosure_snippets(state)
