from __future__ import annotations

from copy import deepcopy

from .models import Constraint, ParsedMessage, SessionState
from .snippets import category_from_opener


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    def reset(self, session_id: str, user_profile: dict) -> SessionState:
        state = SessionState(
            user_profile=deepcopy(user_profile),
            messages=[],
            parsed_messages=[],
            positive_constraints={},
            negative_constraints={},
            unconstrained_attributes=set(),
            disclosed_attributes=set(),
            asked_attributes=set(),
            last_recommendations=[],
            last_asked_attribute=None,
            query_text="",
            override_count=0,
            category_hint="",
        )
        self._sessions[session_id] = state
        return state

    def get(self, session_id: str) -> SessionState:
        try:
            return self._sessions[session_id]
        except KeyError as error:
            raise RuntimeError("reset must be called before respond") from error

    def mark_question(self, state: SessionState, attribute: str | None) -> None:
        state.last_asked_attribute = attribute
        if attribute:
            state.asked_attributes.add(attribute)

    def update(
        self,
        state: SessionState,
        user_message: str,
        parsed: ParsedMessage,
    ) -> SessionState:
        state.messages.append(user_message)
        state.parsed_messages.append(parsed)

        overridden_attrs: set[str] = set()
        if parsed.override:
            overridden_attrs = self._apply_override(state, parsed)
            state.override_count += 1

        if parsed.boundary:
            attribute = state.last_asked_attribute
            if attribute:
                state.unconstrained_attributes.add(attribute)
        else:
            for constraint in parsed.constraints:
                self._add_constraint(state, constraint)
                state.disclosed_attributes.add(constraint.attribute)
                state.unconstrained_attributes.discard(constraint.attribute)

        # An override reply is often a single bare value (e.g. "cotton"), not the
        # full detail (e.g. "90% Cotton, 10% Others") -- both file under the same
        # attribute downstream. Don't treat the replaced attribute as fully
        # answered, so questions.py can ask a direct follow-up instead of only
        # reaching the fuller value via the last-resort "other" question.
        state.disclosed_attributes -= overridden_attrs

        state.query_text = self._build_query_text(state)
        if not state.category_hint and state.messages:
            state.category_hint = category_from_opener(state.messages[0]) or state.category_hint
        return state

    @staticmethod
    def _apply_override(state: SessionState, parsed: ParsedMessage) -> set[str]:
        """Clear only the attribute(s) the customer is actually replacing.

        The override turn's own text is parsed for constraints just like any other
        turn, so the replacement attribute (e.g. "feature") is already known. Wipe
        prior positive/negative constraints for just that attribute, demote its old
        value(s) to negative_constraints so rerank actively avoids them, and only
        fall back to a full wipe (old behavior) when the parser found nothing to
        anchor the override to.
        """
        new_values_by_attr: dict[str, set[str]] = {}
        for constraint in parsed.constraints:
            new_values_by_attr.setdefault(constraint.attribute, set()).add(constraint.value)
        overridden_attrs = {attribute for attribute in new_values_by_attr if attribute != "category"}

        if not overridden_attrs:
            state.positive_constraints = {
                "category": list(state.positive_constraints.get("category", [])),
            }
            state.negative_constraints = {
                "category": list(state.negative_constraints.get("category", [])),
            }
            state.disclosed_attributes = {
                attribute for attribute in state.disclosed_attributes if attribute == "category"
            }
            state.asked_attributes = {
                attribute for attribute in state.asked_attributes if attribute == "category"
            }
            return set()

        for attribute in overridden_attrs:
            old_positive = state.positive_constraints.pop(attribute, [])
            state.negative_constraints.pop(attribute, None)
            state.disclosed_attributes.discard(attribute)
            state.asked_attributes.discard(attribute)
            for old_constraint in old_positive:
                if old_constraint.value in new_values_by_attr.get(attribute, set()):
                    continue
                SessionStore._add_constraint(
                    state,
                    Constraint(attribute, old_constraint.value, "negative", old_constraint.confidence),
                )

        return overridden_attrs

    @staticmethod
    def _add_constraint(state: SessionState, constraint: Constraint) -> None:
        target = (
            state.positive_constraints
            if constraint.polarity == "positive"
            else state.negative_constraints
        )
        values = target.setdefault(constraint.attribute, [])
        if all(existing.value != constraint.value for existing in values):
            values.append(constraint)

    @staticmethod
    def _build_query_text(state: SessionState) -> str:
        constraints = [
            *[item for values in state.positive_constraints.values() for item in values],
            *[item for values in state.negative_constraints.values() for item in values],
        ]
        values = [
            item.value
            for item in sorted(constraints, key=lambda item: (item.attribute, item.value, item.polarity))
            if item.attribute not in state.unconstrained_attributes
        ]
        return " ".join(dict.fromkeys(values))
