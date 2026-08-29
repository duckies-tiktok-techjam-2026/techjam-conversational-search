from __future__ import annotations

import unittest

from starter.components.search_plan import build_search_plan
from starter.components.session_store import SessionStore
from starter.components.parser import parse_message


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
        self.assertEqual(plan.exact_phrases, ["black leather hiking boots"])
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

    def test_override_state_drops_only_the_replaced_attribute(self) -> None:
        self.store.update(self.state, "black leather", parse_message("black leather"))
        self.store.update(self.state, "Actually cotton", parse_message("Actually cotton"))

        plan = build_search_plan(self.state)

        # Override text only names material (cotton), so color (black) survives
        # as a required term; the stale material value moves to excluded_terms
        # instead of just disappearing.
        self.assertEqual(plan.required_terms, ["black", "cotton"])
        self.assertNotIn("leather", plan.required_terms)
        self.assertEqual(plan.excluded_terms, ["leather"])
        self.assertEqual(plan.exact_phrases, ["actually cotton"])


if __name__ == "__main__":
    unittest.main()
