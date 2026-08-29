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

    def test_override_only_clears_the_attribute_it_replaces(self) -> None:
        self.store.update(self.state, "black leather boots", parse_message("black leather boots"))
        self.store.update(
            self.state,
            "Actually, I need cotton instead.",
            parse_message("Actually, I need cotton instead."),
        )

        # Override text only names "material" (cotton), so unrelated attributes
        # disclosed earlier (color, category) must survive untouched.
        self.assertEqual([item.value for item in self.state.positive_constraints["color"]], ["black"])
        self.assertEqual([item.value for item in self.state.positive_constraints["category"]], ["boots"])
        self.assertIn("color", self.state.disclosed_attributes)
        self.assertIn("category", self.state.disclosed_attributes)

        # The replaced attribute's old value is demoted to a negative constraint
        # rather than merely dropped, and the new value takes over positively.
        self.assertNotIn("leather", [item.value for item in self.state.positive_constraints.get("material", [])])
        self.assertEqual([item.value for item in self.state.positive_constraints["material"]], ["cotton"])
        self.assertEqual([item.value for item in self.state.negative_constraints["material"]], ["leather"])
        self.assertEqual(self.state.override_count, 1)

        # The override reply is often a terse single value ("cotton") standing in
        # for a fuller spec disclosed later ("90% cotton, 10% others"). Don't mark
        # the replaced attribute as fully answered -- questions.py must still be
        # willing to ask "material" again to draw that fuller value out, rather
        # than only reaching it via the last-resort "other" question.
        self.assertNotIn("material", self.state.disclosed_attributes)

    def test_override_falls_back_to_full_wipe_when_replacement_is_unparseable(self) -> None:
        self.store.update(self.state, "black leather boots", parse_message("black leather boots"))
        self.store.update(
            self.state,
            "Actually, I changed my mind about the whole thing.",
            parse_message("Actually, I changed my mind about the whole thing."),
        )

        self.assertNotIn("color", self.state.positive_constraints)
        self.assertNotIn("material", self.state.positive_constraints)
        self.assertEqual(self.state.disclosed_attributes, {"category"})
        self.assertEqual(self.state.override_count, 1)

    def test_override_clears_asked_attributes_for_the_replaced_attribute(self) -> None:
        self.store.mark_question(self.state, "material")
        self.store.update(self.state, "black leather boots", parse_message("black leather boots"))
        self.store.update(
            self.state,
            "Actually, I need cotton instead.",
            parse_message("Actually, I need cotton instead."),
        )

        self.assertNotIn("material", self.state.asked_attributes)

    def test_sessions_are_isolated(self) -> None:
        other = self.store.reset("session-b", {})
        self.store.update(self.state, "black", parse_message("black"))

        self.assertEqual(other.query_text, "")
        self.assertEqual(other.positive_constraints, {})


if __name__ == "__main__":
    unittest.main()
