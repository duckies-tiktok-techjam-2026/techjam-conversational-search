from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.session_store import SessionStore


class SessionStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = SessionStore()
        self.state = self.store.reset("session-a", {"preference_tags": ["comfort"]})

    def test_reset_creates_empty_state_and_copies_profile(self) -> None:
        profile = {"preference_tags": ["comfort"]}
        state = self.store.reset("session-b", profile)
        profile["preference_tags"].append("fit")

        self.assertEqual(state.user_profile, {"preference_tags": ["comfort"]})
        self.assertEqual(state.messages, [])
        self.assertEqual(state.positive_constraints, {})
        self.assertEqual(state.disclosed_attributes, set())
        self.assertEqual(state.asked_attributes, set())

    def test_get_unknown_session_raises(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "reset must be called"):
            self.store.get("missing")

    def test_update_accumulates_and_deduplicates_constraints(self) -> None:
        parsed = parse_message("black leather")
        self.store.update(self.state, "black leather", parsed)
        self.store.update(self.state, "still black leather", parse_message("black leather"))

        self.assertEqual([item.value for item in self.state.positive_constraints["color"]], ["black"])
        self.assertEqual([item.value for item in self.state.positive_constraints["material"]], ["leather"])
        self.assertEqual(self.state.disclosed_attributes, {"color", "material"})
        self.assertEqual(self.state.query_text, "black leather")

    def test_boundary_marks_asked_attribute_without_disclosing_it(self) -> None:
        self.store.mark_question(self.state, "color")
        self.store.update(
            self.state,
            "I have no preference; use your judgment.",
            parse_message("I have no preference; use your judgment."),
        )

        self.assertEqual(self.state.asked_attributes, {"color"})
        self.assertEqual(self.state.unconstrained_attributes, {"color"})
        self.assertNotIn("color", self.state.disclosed_attributes)

    def test_override_preserves_category_and_removes_stale_constraints(self) -> None:
        self.store.update(self.state, "black leather boots", parse_message("black leather boots"))
        self.store.update(
            self.state,
            "Actually, I need cotton instead.",
            parse_message("Actually, I need cotton instead."),
        )

        self.assertNotIn("color", self.state.positive_constraints)
        self.assertNotIn("leather", [item.value for item in self.state.positive_constraints.get("material", [])])
        self.assertEqual([item.value for item in self.state.positive_constraints["material"]], ["cotton"])
        self.assertEqual(self.state.override_count, 1)
        self.assertEqual(self.state.query_text, "boots cotton")

    def test_sessions_are_isolated(self) -> None:
        other = self.store.reset("session-b", {})
        self.store.update(self.state, "black", parse_message("black"))

        self.assertEqual(other.query_text, "")
        self.assertEqual(other.positive_constraints, {})


if __name__ == "__main__":
    unittest.main()
