from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.rerank import rerank, score_product
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

    def test_retrieval_prior_does_not_override_color_violation(self) -> None:
        self.store.update(self.state, "black leather boots without red", parse_message("black leather boots without red"))
        plan = build_search_plan(self.state)
        red_boot = {
            **self.leather_boot,
            "parent_asin": "RED_BOOT",
            "title": "Red leather hiking boots",
        }
        ranked = rerank(
            [
                {"parent_asin": "RED_BOOT", "retrieval_score": 200.0},
                {"parent_asin": "BOOT", "retrieval_score": 10.0},
            ],
            self.state,
            plan,
            {**self.products, "RED_BOOT": red_boot},
        )
        self.assertEqual(ranked[0], "BOOT")

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
