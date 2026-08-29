from __future__ import annotations

from .models import SessionState


EMPTY_INTENT_PRIORITY = ("category", "use_case", "feature", "material", "color", "size", "style", "brand", "budget")
ACTIVE_INTENT_PRIORITY = ("feature", "material", "color", "size", "style", "brand", "budget", "use_case", "category")
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
    del turn
    priorities = ACTIVE_INTENT_PRIORITY if state.positive_constraints else EMPTY_INTENT_PRIORITY
    excluded = state.disclosed_attributes | state.unconstrained_attributes | state.asked_attributes
    for attribute in priorities:
        if attribute not in excluded:
            return attribute
    return None


def question_text(attribute: str | None) -> str:
    if attribute is None:
        return "Here are the closest matches I found."
    return QUESTION_TEXT.get(attribute, QUESTION_TEXT["other"])
