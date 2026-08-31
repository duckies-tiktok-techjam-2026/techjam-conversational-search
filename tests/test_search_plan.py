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
        # Phrased the way the simulator opens a `buying` session: the lead-in is
        # boilerplate, everything after the colon is the disclosed constraint.
        opener = "I'm looking for boots. A key requirement is: black leather hiking boots."
        self.store.update(self.state, opener, parse_message(opener))
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

    def test_phrases_are_the_disclosed_clues_not_the_whole_turn(self) -> None:
        opener = "I'm looking for t-shirts. A key requirement is: fabric type: 100% cotton."
        self.store.update(self.state, opener, parse_message(opener))
        reply = "For that, what matters is: 4.3 oz jersey knit; tagless collar."
        self.store.update(self.state, reply, parse_message(reply))

        plan = build_search_plan(self.state)

        self.assertEqual(
            plan.exact_phrases,
            ["fabric type: 100% cotton", "4.3 oz jersey knit", "tagless collar"],
        )
        # The parser's vocab lists only reach "cotton"; retrieval matched on the
        # rest, and now so does rerank.
        for term in ("jersey", "knit", "tagless", "collar", "oz"):
            self.assertIn(term, plan.snippet_terms)
        # "4.3" survives only as a phrase -- tokenization splits it and drops the
        # single characters.
        self.assertNotIn("4.3", plan.snippet_terms)

    def test_non_answer_turns_contribute_no_phrases(self) -> None:
        self.store.mark_question(self.state, "color")
        reply = "I don't have a preference for color; please use your judgment."
        self.store.update(self.state, reply, parse_message(reply))

        self.assertEqual(build_search_plan(self.state).exact_phrases, [])

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
        # The pre-override clue is retained (demoted, not dropped -- see
        # snippets._PRE_OVERRIDE_WEIGHT). It used to vanish here only because a
        # colon-less turn 0 was discarded wholesale, which also threw away real
        # turn-1 disclosures whenever the customer phrased one without a colon.
        self.assertEqual(plan.exact_phrases, ["black leather", "actually cotton"])


if __name__ == "__main__":
    unittest.main()
