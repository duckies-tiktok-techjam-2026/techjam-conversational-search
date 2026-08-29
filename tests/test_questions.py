from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.questions import choose_question_attribute, question_text
from starter.components.session_store import SessionStore


class QuestionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.state = SessionStore().reset("session", {})

    def test_empty_state_starts_with_category(self) -> None:
        self.assertEqual(choose_question_attribute(self.state, 1), "category")

    def test_active_intent_prioritizes_feature(self) -> None:
        self.state.positive_constraints["material"] = parse_message("leather").constraints
        self.state.disclosed_attributes.add("material")

        self.assertEqual(choose_question_attribute(self.state, 2), "feature")

    def test_excludes_disclosed_unconstrained_and_asked_attributes(self) -> None:
        self.state.positive_constraints["category"] = parse_message("boots").constraints
        self.state.disclosed_attributes.add("category")
        self.state.unconstrained_attributes.add("feature")
        self.state.asked_attributes.add("material")

        self.assertEqual(choose_question_attribute(self.state, 2), "color")

    def test_returns_none_when_all_question_attributes_are_exhausted(self) -> None:
        self.state.asked_attributes.update({
            "category", "use_case", "feature", "material", "color",
            "size", "style", "brand", "budget",
        })

        self.assertIsNone(choose_question_attribute(self.state, 10))

    def test_question_text_has_fallback(self) -> None:
        self.assertEqual(question_text("budget"), "What budget should I stay within?")
        self.assertEqual(question_text("unknown"), "Is there another requirement I should consider?")
        self.assertEqual(question_text(None), "Here are the closest matches I found.")


if __name__ == "__main__":
    unittest.main()
