from __future__ import annotations

import json
from pathlib import Path

from .components.models import SessionState
from .components.parser import parse_message
from .components.questions import choose_question_attribute, question_text
from .components.rerank import CANDIDATE_POOL_SIZE, rerank
from .components.retrieval import CandidateIndex
from .components.search_plan import build_search_plan
from .components.session_store import SessionStore


class Agent:
    """Stateful retrieval plus structured constraint reranking."""

    def __init__(self, catalog_path: str | Path = "data/catalog.jsonl") -> None:
        self.catalog_path = Path(catalog_path)
        self.session_store = SessionStore()
        self.products: dict[str, dict] = {}
        self._load_products()
        self.candidate_index = CandidateIndex(self.catalog_path)

    def _load_products(self) -> None:
        with self.catalog_path.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                product = json.loads(line)
                parent_asin = str(product["parent_asin"])
                product["parent_asin"] = parent_asin
                self.products[parent_asin] = product

    def reset(self, session_id: str, user_profile: dict) -> None:
        self.session_store.reset(session_id, user_profile)

    def _retrieve_candidates(self, state: SessionState) -> list[dict]:
        return [
            {
                "parent_asin": candidate.parent_asin,
                "retrieval_score": candidate.fts_score,
                "path_ranks": dict(candidate.path_ranks),
            }
            for candidate in self.candidate_index.get_candidates(state, pool_size=CANDIDATE_POOL_SIZE)
        ]

    def respond(
        self,
        session_id: str,
        user_message: str,
        turn: int,
        top_k: int,
    ) -> dict:
        state = self.session_store.get(session_id)
        parsed = parse_message(user_message)
        self.session_store.update(state, user_message, parsed)
        state.last_search_plan = build_search_plan(state)
        ranked = rerank(
            self._retrieve_candidates(state),
            state,
            state.last_search_plan,
            self.products,
        )
        recommendations = [{"parent_asin": parent_asin} for parent_asin in ranked[:top_k]]
        state.last_recommendations = [item["parent_asin"] for item in recommendations]
        ask_attribute = choose_question_attribute(state, turn)
        self.session_store.mark_question(state, ask_attribute)
        return {
            "message": question_text(ask_attribute),
            "ask_attribute": ask_attribute,
            "recommendations": recommendations,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }
