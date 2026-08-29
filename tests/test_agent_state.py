from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from starter.agent import Agent


class AgentStateIntegrationTest(unittest.TestCase):
    def test_agent_uses_stateful_query_and_reset_isolates_sessions(self) -> None:
        products = [
            {
                "parent_asin": "A",
                "title": "Black leather hiking boots",
                "categories": ["Shoes"],
                "features": ["water resistant"],
                "details": {},
                "store": "Example",
                "description": [],
            },
            {
                "parent_asin": "B",
                "title": "Blue cotton running shoes",
                "categories": ["Shoes"],
                "features": ["lightweight"],
                "details": {},
                "store": "Example",
                "description": [],
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / "catalog.jsonl"
            catalog_path.write_text(
                "".join(json.dumps(product) + "\n" for product in products),
                encoding="utf-8",
            )
            agent = Agent(catalog_path)
            agent.reset("one", {"preference_tags": ["durability"]})
            agent.reset("two", {})

            agent.respond("one", "black", 1, 10)
            result = agent.respond("one", "leather boots", 2, 10)
            state = agent.session_store.get("one")

            self.assertEqual(state.messages, ["black", "leather boots"])
            self.assertIn("black", state.query_text)
            self.assertIn("leather", state.query_text)
            self.assertIsNotNone(state.last_search_plan)
            assert state.last_search_plan is not None
            self.assertIn("leather", state.last_search_plan.required_terms)
            self.assertEqual(state.last_recommendations, [item["parent_asin"] for item in result["recommendations"]])
            self.assertEqual(agent.session_store.get("two").query_text, "")

    def test_agent_rejects_unknown_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / "catalog.jsonl"
            catalog_path.write_text(
                json.dumps({"parent_asin": "A", "title": "Item"}) + "\n",
                encoding="utf-8",
            )
            agent = Agent(catalog_path)

            with self.assertRaisesRegex(RuntimeError, "reset must be called"):
                agent.respond("missing", "item", 1, 10)


if __name__ == "__main__":
    unittest.main()
