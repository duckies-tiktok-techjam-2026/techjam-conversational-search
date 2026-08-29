from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.search_plan import build_search_plan, exact_phrases_for_state
from starter.components.session_store import SessionStore


class SearchPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = SessionStore()
        self.state = self.store.reset(
            "session",
            {"preference_tags": ["Comfort", "fit", "comfort"]},
        )

    def test_builds_required_optional_excluded_and_phrase_inputs(self) -> None:
        self.store.update(
            self.state,
            "Black leather hiking boots",
            parse_message("Black leather hiking boots"),
        )
        self.state.negative_constraints["color"] = [
            parse_message("without red").constraints[0]
        ]

        plan = build_search_plan(self.state)

        self.assertEqual(plan.required_terms, ["leather", "black", "hiking", "boots"])
        self.assertEqual(plan.optional_terms, ["comfort", "fit"])
        self.assertEqual(plan.excluded_terms, ["red"])
        self.assertEqual(plan.exact_phrases, [])
        self.assertEqual(plan.attribute_values["material"], ["leather"])
        self.assertEqual(plan.attribute_values["color"], ["black"])

    def test_omits_boundary_attributes(self) -> None:
        self.store.mark_question(self.state, "color")
        self.store.update(
            self.state,
            "No preference; use your judgment.",
            parse_message("No preference; use your judgment."),
        )
        self.store.update(self.state, "leather boots", parse_message("leather boots"))

        plan = build_search_plan(self.state)

        self.assertNotIn("color", plan.attribute_values)
        self.assertNotIn("color", plan.required_terms)
        self.assertEqual(plan.required_terms, ["leather", "boots"])

    def test_override_state_drops_stale_values(self) -> None:
        self.store.update(self.state, "black leather", parse_message("black leather"))
        self.store.update(self.state, "Actually cotton", parse_message("Actually cotton"))

        plan = build_search_plan(self.state)

        self.assertEqual(plan.required_terms, ["cotton"])
        self.assertNotIn("leather", plan.required_terms)
        self.assertEqual(plan.exact_phrases, ["actually cotton"])

    def test_colon_lead_in_yields_payload_only(self) -> None:
        self.store.update(
            self.state,
            "I'm looking for shirts. A key requirement is: 4.3 oz jersey knit.",
            parse_message("I'm looking for shirts. A key requirement is: 4.3 oz jersey knit."),
        )

        phrases = exact_phrases_for_state(self.state)

        self.assertEqual(phrases, ["4.3 oz jersey knit"])

    def test_non_answer_turn_contributes_no_phrases(self) -> None:
        self.store.update(self.state, "leather boots", parse_message("leather boots"))
        self.store.update(
            self.state,
            "I don't have a preference for color; please use your judgment.",
            parse_message("I don't have a preference for color; please use your judgment."),
        )

        phrases = exact_phrases_for_state(self.state)

        self.assertEqual(phrases, [])

    def test_semicolon_disclosure_splits_into_phrases(self) -> None:
        self.store.update(
            self.state,
            "For that, what matters is: tagless; 100% cotton jersey knit.",
            parse_message("For that, what matters is: tagless; 100% cotton jersey knit."),
        )

        phrases = exact_phrases_for_state(self.state)

        self.assertEqual(phrases, ["100% cotton jersey knit"])

    def test_single_token_snippets_are_dropped(self) -> None:
        self.store.update(
            self.state,
            "For that, what matters is: cotton.",
            parse_message("For that, what matters is: cotton."),
        )

        phrases = exact_phrases_for_state(self.state)

        self.assertEqual(phrases, [])


if __name__ == "__main__":
    unittest.main()
