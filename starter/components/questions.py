from __future__ import annotations

from .models import SessionState


# Prefer the highest-yield attributes first. The simulator is most informative when we ask
# for a concrete discriminating attribute (especially "feature") instead of repeating broad
# or already-exhausted categories.
EMPTY_INTENT_PRIORITY = ("feature", "category", "use_case", "material", "color", "size", "style", "brand", "budget", "other")
ACTIVE_INTENT_PRIORITY = ("feature", "material", "color", "size", "style", "brand", "budget", "use_case", "category", "other")
QUESTION_TEXT = {
    "category": "What type of item are you looking for?",
    "material": "Do you have a material preference?",
    "color": "Do you have a preferred color?",
    "size": "What size or fit do you need?",
    "style": "Is there a particular style or fit you prefer?",
    "brand": "Do you have a preferred brand?",
    "budget": "What budget should I stay within?",
    "feature": "What feature matters most to you?",
    "use_case": "What will you mainly use it for?",
    "other": "Is there another requirement I should consider?",
}


def choose_question_attribute(state: SessionState, turn: int) -> str | None:
    excluded = state.disclosed_attributes | state.unconstrained_attributes | state.asked_attributes
    if state.last_asked_attribute:
        excluded = excluded | {state.last_asked_attribute}

    if state.parsed_messages and state.parsed_messages[-1].override:
        for constraint in state.parsed_messages[-1].constraints:
            if constraint.attribute not in excluded and constraint.attribute != "category":
                return constraint.attribute

    if turn >= 7 and "other" not in excluded:
        return "other"

    priorities = ACTIVE_INTENT_PRIORITY if state.positive_constraints else EMPTY_INTENT_PRIORITY
    if state.messages and "key requirement is" in str(state.messages[0]).lower():
        priorities = ("feature", "material", "color", "other", "size", "style", "brand", "budget", "use_case", "category")
    elif turn >= 5 and "other" not in excluded:
        priorities = ("other", *priorities)

    for attribute in priorities:
        if attribute not in excluded:
            return attribute
    return None


def question_text(attribute: str | None) -> str:
    if attribute is None:
        return "Here are the closest matches I found."
    return QUESTION_TEXT.get(attribute, QUESTION_TEXT["other"])
