from __future__ import annotations

import unittest

from starter.agent import parse_message


class ParserTest(unittest.TestCase):
    def test_normalizes_text_and_removes_stopwords_from_tokens(self) -> None:
        parsed = parse_message("  I am Looking for  blue shoes, please.  ")

        self.assertEqual(parsed.normalized_text, "i am looking for blue shoes, please.")
        self.assertEqual(parsed.tokens, ["blue", "shoes"])

    def test_extracts_common_positive_constraints(self) -> None:
        parsed = parse_message("I need black leather hiking boots under $100 in large size.")

        constraints = {(item.attribute, item.value, item.polarity) for item in parsed.constraints}
        self.assertIn(("material", "leather", "positive"), constraints)
        self.assertIn(("color", "black", "positive"), constraints)
        self.assertIn(("use_case", "hiking", "positive"), constraints)
        self.assertIn(("size", "large", "positive"), constraints)
        self.assertIn(("budget", "maximum $100", "positive"), constraints)

    def test_extracts_bounded_category_style_feature_and_brand_signals(self) -> None:
        parsed = parse_message("I want casual waterproof boots from brand Acme.")

        constraints = {(item.attribute, item.value, item.polarity) for item in parsed.constraints}
        self.assertIn(("category", "boots", "positive"), constraints)
        self.assertIn(("style", "casual", "positive"), constraints)
        self.assertIn(("feature", "waterproof", "positive"), constraints)
        self.assertIn(("brand", "acme", "positive"), constraints)

    def test_budget_patterns_do_not_overlap(self) -> None:
        parsed = parse_message("Keep it under $100, please.")

        budgets = [item.value for item in parsed.constraints if item.attribute == "budget"]
        self.assertEqual(budgets, ["maximum $100"])

    def test_extracts_negative_constraints(self) -> None:
        parsed = parse_message("I do not want red. I do not want wool.")

        constraints = {(item.attribute, item.value, item.polarity) for item in parsed.constraints}
        self.assertIn(("color", "red", "negative"), constraints)
        self.assertIn(("material", "wool", "negative"), constraints)

    def test_deduplicates_constraints(self) -> None:
        parsed = parse_message("Black, black shoes in black leather.")

        black_colors = [
            item for item in parsed.constraints
            if item.attribute == "color" and item.value == "black"
        ]
        self.assertEqual(len(black_colors), 1)

    def test_detects_override_boundary_and_feedback_signals(self) -> None:
        override = parse_message("Actually, ignore my earlier preference. I changed my mind.")
        boundary = parse_message("No preference for color; use your judgment.")
        feedback = parse_message("Those options are not quite right. Try again.")

        self.assertTrue(override.override)
        self.assertTrue(boundary.boundary)
        self.assertTrue(feedback.generic_feedback)

    def test_empty_message_is_safe(self) -> None:
        parsed = parse_message("")

        self.assertEqual(parsed.normalized_text, "")
        self.assertEqual(parsed.tokens, [])
        self.assertEqual(parsed.constraints, [])
        self.assertFalse(parsed.override)
        self.assertFalse(parsed.boundary)
        self.assertFalse(parsed.generic_feedback)


if __name__ == "__main__":
    unittest.main()
