from __future__ import annotations

from .models import SearchPlan, SessionState


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
    )


def exact_phrases_for_state(state: SessionState) -> list[str]:
    start_index = 0
    for index, parsed in enumerate(state.parsed_messages):
        if parsed.override:
            start_index = index
    return list(dict.fromkeys(
        parsed.normalized_text
        for parsed in state.parsed_messages[start_index:][-2:]
        if len(parsed.tokens) > 1
    ))
