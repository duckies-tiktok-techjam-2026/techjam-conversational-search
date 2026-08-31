"""The disclosure pipeline must survive a customer who rephrases things.

``competition_specification.md:40`` reserves the right to add natural-language
paraphrasing on the private split. Every assertion here pairs a simulator-exact
phrasing with a reworded one carrying the same content, and requires that the
discriminative tokens survive both. Before the fixes these tracked, a reworded
opener or a colon-less lead-in silently dropped the whole turn.

Measured effect (``python3 -m scripts.robustness_check``, rule-only): paraphrase
cost fell from -0.243 to -0.042 TechnicalScore with the public set unchanged.
"""

from __future__ import annotations

import unittest

from starter.components.parser import parse_message
from starter.components.session_store import SessionStore
from starter.components.snippets import (
    NON_ANSWER_RE,
    category_from_opener,
    disclosure_snippets,
    snippet_terms,
)


def _state(*messages: str):
    store = SessionStore()
    state = store.reset("session", {"preference_tags": []})
    for message in messages:
        store.update(state, message, parse_message(message))
    return state


class CategoryExtractionTest(unittest.TestCase):
    def test_recognises_the_simulator_opener(self) -> None:
        self.assertEqual(
            category_from_opener("I'm looking for hiking boots, but I'm still exploring."),
            "hiking boots",
        )

    def test_recognises_reworded_openers(self) -> None:
        for opener, expected in [
            ("I need hiking boots, but I'm still exploring.", "hiking boots"),
            ("I'm shopping for hiking boots. Something warm.", "hiking boots"),
            ("Hi, I want to find hiking boots, just browsing.", "hiking boots"),
        ]:
            with self.subTest(opener=opener):
                self.assertEqual(category_from_opener(opener), expected)

    def test_falls_back_to_the_first_clause(self) -> None:
        # No recognised opener verb at all -- the category is still the first thing
        # the customer names, so we must not return empty and lose the category.
        self.assertEqual(category_from_opener("hiking boots, please."), "hiking boots")

    def test_no_clause_yields_empty_rather_than_garbage(self) -> None:
        self.assertEqual(category_from_opener(""), "")
        self.assertEqual(category_from_opener("boots"), "")


class NonAnswerTest(unittest.TestCase):
    def test_matches_the_simulator_non_answers(self) -> None:
        for text in [
            "i don't have a preference for color; please use your judgment.",
            "i don't have an additional preference for size.",
            "those options are not quite right yet. ask me about one specific attribute.",
        ]:
            with self.subTest(text=text):
                self.assertTrue(NON_ANSWER_RE.search(text))

    def test_matches_reworded_non_answers(self) -> None:
        for text in [
            "i'm not fussy about color -- either is fine.",
            "no strong feelings on size, whatever you think is best.",
            "nothing else to add on style.",
            "that's all i have on material.",
            "those aren't what i'm after.",
            "it doesn't matter to me.",
        ]:
            with self.subTest(text=text):
                self.assertTrue(NON_ANSWER_RE.search(text))

    def test_a_real_disclosure_is_not_a_non_answer(self) -> None:
        self.assertFalse(NON_ANSWER_RE.search("for that, what matters is: 100% cotton jersey"))
        self.assertFalse(NON_ANSWER_RE.search("the fabric is 100% cotton"))


class DisclosureSurvivesRewordingTest(unittest.TestCase):
    def test_buying_opener_with_and_without_the_colon(self) -> None:
        # The colon lead-in is a simulator artifact; the constraint behind it must
        # reach the ranking query either way.
        for opener in [
            "I'm looking for boots. A key requirement is: black leather hiking boots.",
            "I need boots -- it has to be black leather hiking boots.",
            "I'm shopping for boots and it must be black leather hiking boots.",
        ]:
            with self.subTest(opener=opener):
                terms = snippet_terms(disclosure_snippets(_state(opener)))
                for token in ("black", "leather", "hiking"):
                    self.assertIn(token, terms)

    def test_reply_lead_in_does_not_leak_meta_words(self) -> None:
        opener = "I'm looking for shirts, but I'm still exploring."
        for reply in [
            "For that, what matters is: fabric type: 100% cotton.",
            "What matters there is the fabric type is 100% cotton.",
            "Mainly the fabric type is 100% cotton.",
        ]:
            with self.subTest(reply=reply):
                # snippet_terms is the query that actually reaches retrieval and
                # rerank; the raw snippet string still carries the scaffolding.
                terms = snippet_terms(disclosure_snippets(_state(opener, reply)))
                self.assertIn("cotton", terms)
                # If these reach retrieval they get ANDed as low-df "rare" terms
                # and match almost nothing.
                for meta in ("matters", "mainly", "what"):
                    self.assertNotIn(meta, terms)

    def test_browsing_opener_contributes_no_snippet(self) -> None:
        # Pure filler either way -- the category is carried separately.
        for opener in [
            "I'm looking for shirts, but I'm still exploring.",
            "I need shirts and I'm just browsing for now.",
        ]:
            with self.subTest(opener=opener):
                self.assertEqual(disclosure_snippets(_state(opener)), [])

    def test_non_answer_turn_adds_nothing_when_reworded(self) -> None:
        opener = "I'm looking for shirts. A key requirement is: 100% cotton."
        baseline = disclosure_snippets(_state(opener))
        for reply in [
            "I don't have an additional preference for size.",
            "Nothing else to add on size.",
            "No strong feelings on size, whatever you think is best.",
        ]:
            with self.subTest(reply=reply):
                self.assertEqual(disclosure_snippets(_state(opener, reply)), baseline)


if __name__ == "__main__":
    unittest.main()
