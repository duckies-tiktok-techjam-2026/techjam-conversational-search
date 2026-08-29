from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.rerank import _field_map, _phrase_score, rerank, score_product
from starter.components.search_plan import build_search_plan
from starter.components.session_store import SessionStore


class RerankTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = SessionStore()
        self.state = self.store.reset("session", {"preference_tags": ["comfort"]})
        self.leather_boot = {
            "parent_asin": "BOOT",
            "title": "Black leather hiking boots",
            "categories": ["Shoes", "Boots"],
            "features": ["waterproof", "durable"],
            "details": {"Material": "leather"},
            "store": "Trail Co",
            "description": ["Comfortable hiking boot"],
            "price": 80.0,
            "average_rating": 4.6,
            "rating_number": 200,
        }
        self.red_shirt = {
            "parent_asin": "SHIRT",
            "title": "Red cotton t-shirt",
            "categories": ["Clothing", "Shirts"],
            "features": ["lightweight"],
            "details": {},
            "store": "Casual Co",
            "description": ["Everyday shirt"],
            "price": 20.0,
            "average_rating": 4.8,
            "rating_number": 5000,
        }
        self.products = {
            "BOOT": self.leather_boot,
            "SHIRT": self.red_shirt,
        }

    def test_hard_constraints_outrank_unrelated_popular_item(self) -> None:
        self.store.update(self.state, "black leather hiking boots", parse_message("black leather hiking boots"))
        plan = build_search_plan(self.state)
        ranked = rerank(
            [
                {"parent_asin": "SHIRT", "retrieval_score": 12.0},
                {"parent_asin": "BOOT", "retrieval_score": 3.0},
            ],
            self.state,
            plan,
            self.products,
        )
        self.assertEqual(ranked[0], "BOOT")

    def test_excluded_color_is_penalized(self) -> None:
        self.store.update(self.state, "leather boots without red", parse_message("leather boots without red"))
        plan = build_search_plan(self.state)
        red_boot = {
            **self.leather_boot,
            "parent_asin": "RED_BOOT",
            "title": "Red leather hiking boots",
        }
        products = {**self.products, "RED_BOOT": red_boot}
        ranked = rerank(
            [
                {"parent_asin": "RED_BOOT", "retrieval_score": 8.0},
                {"parent_asin": "BOOT", "retrieval_score": 8.0},
            ],
            self.state,
            plan,
            products,
        )
        self.assertEqual(ranked[0], "BOOT")

    def test_boundary_attribute_is_not_penalized(self) -> None:
        self.store.mark_question(self.state, "color")
        self.store.update(
            self.state,
            "No preference; use your judgment.",
            parse_message("No preference; use your judgment."),
        )
        self.store.update(self.state, "leather boots", parse_message("leather boots"))
        plan = build_search_plan(self.state)
        self.assertNotIn("color", plan.attribute_values)
        black_score = score_product(self.leather_boot, self.state, plan)
        red_boot = {**self.leather_boot, "parent_asin": "RED_BOOT", "title": "Red leather hiking boots"}
        red_score = score_product(red_boot, self.state, plan)
        self.assertGreater(black_score, 0)
        self.assertGreater(red_score, 0)

    def test_budget_maximum_penalizes_overpriced_items(self) -> None:
        self.store.update(self.state, "boots under $40", parse_message("boots under $40"))
        plan = build_search_plan(self.state)
        cheap = {**self.leather_boot, "parent_asin": "CHEAP", "title": "Leather hiking boots", "price": 35.0}
        expensive = {**self.leather_boot, "parent_asin": "EXPENSIVE", "title": "Leather hiking boots", "price": 120.0}
        ranked = rerank(
            [{"parent_asin": "EXPENSIVE"}, {"parent_asin": "CHEAP"}],
            self.state,
            plan,
            {"CHEAP": cheap, "EXPENSIVE": expensive},
        )
        self.assertEqual(ranked[0], "CHEAP")

    def test_generic_feedback_demotes_previous_top_hit(self) -> None:
        self.store.update(self.state, "leather boots", parse_message("leather boots"))
        self.state.last_recommendations = ["BOOT"]
        self.store.update(self.state, "not quite right", parse_message("not quite right"))
        plan = build_search_plan(self.state)
        similar = {
            **self.leather_boot,
            "parent_asin": "BOOT2",
            "title": "Black leather hiking boots wide",
        }
        ranked = rerank(
            [{"parent_asin": "BOOT"}, {"parent_asin": "BOOT2"}],
            self.state,
            plan,
            {**self.products, "BOOT2": similar},
        )
        self.assertEqual(ranked[0], "BOOT2")

    def test_verbatim_clue_outranks_a_product_the_parser_cannot_tell_apart(self) -> None:
        # Both shirts are cotton, so every parsed constraint matches both; only the
        # verbatim clue text ("4.3 oz jersey knit", "tagless") separates them.
        message = "For that, what matters is: fabric type: 100% cotton; 4.3 oz jersey knit tagless"
        self.store.update(self.state, message, parse_message(message))
        plan = build_search_plan(self.state)
        target = {
            "parent_asin": "TEE",
            "title": "Classic cotton tee",
            "categories": ["Clothing", "Shirts"],
            "features": ["4.3 oz jersey knit tagless"],
            "details": {"Fabric type": "100% Cotton"},
            "store": "Tee Co",
            "description": ["Everyday tee"],
            "price": 15.0,
            "average_rating": 4.2,
            "rating_number": 40,
        }
        decoy = {
            **target,
            "parent_asin": "DECOY",
            "features": ["heavyweight fleece"],
            "details": {"Fabric type": "100% Cotton"},
            "average_rating": 4.9,
            "rating_number": 90000,
        }
        ranked = rerank(
            [
                {"parent_asin": "DECOY", "retrieval_score": 9.0},
                {"parent_asin": "TEE", "retrieval_score": 6.0},
            ],
            self.state,
            plan,
            {"TEE": target, "DECOY": decoy},
        )
        self.assertEqual(ranked[0], "TEE")

    def test_phrase_match_ignores_punctuation_between_the_two_renderings(self) -> None:
        # The customer says "fabric type: 100% cotton"; the same detail reaches the
        # scorer as "fabric type 100% cotton".
        message = "For that, what matters is: fabric type: 100% cotton"
        self.store.update(self.state, message, parse_message(message))
        plan = build_search_plan(self.state)
        matching = {**self.red_shirt, "parent_asin": "MATCH", "details": {"Fabric type": "100% Cotton"}}
        self.assertEqual(plan.exact_phrases, ["fabric type: 100% cotton"])
        self.assertEqual(_phrase_score(_field_map(matching), plan.exact_phrases), 2.5)

    def test_deduplicates_and_drops_blank_ids(self) -> None:
        self.store.update(self.state, "boots", parse_message("boots"))
        plan = build_search_plan(self.state)
        ranked = rerank(
            [
                {"parent_asin": "BOOT", "retrieval_score": 1.0},
                {"parent_asin": "BOOT", "retrieval_score": 9.0},
                {"parent_asin": "  "},
            ],
            self.state,
            plan,
            self.products,
        )
        self.assertEqual(ranked, ["BOOT"])


if __name__ == "__main__":
    unittest.main()
