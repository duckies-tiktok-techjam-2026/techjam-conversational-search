from __future__ import annotations

from copy import deepcopy

from .models import Constraint, ParsedMessage, SessionState


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

        if parsed.override:
            state.positive_constraints = {
                "category": list(state.positive_constraints.get("category", [])),
            }
            state.negative_constraints = {
                "category": list(state.negative_constraints.get("category", [])),
            }
            state.disclosed_attributes = {
                attribute for attribute in state.disclosed_attributes if attribute == "category"
            }
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

        state.query_text = self._build_query_text(state)
        return state

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
