"""Offline recall harness for the candidate pool.

Isolates the pool from the parser and question policy: it synthesizes the fully /
partially disclosed constraint state straight from ground truth (via the
evaluator's own ``intent_card``), then checks whether the target survives into
``get_candidates``. The only number that matters here is recall = P(target in pool).

    python3 -m scripts.recall_check
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from evaluator.local_evaluator import (
    catalog_index,
    classify_constraint,
    coarse_category,
    intent_card,
)
from starter.components.models import Constraint, SessionState
from starter.components.retrieval import CandidateIndex

_CATALOG = Path("data/catalog.jsonl") if Path("data/catalog.jsonl").exists() else Path("catalog.jsonl")
_DATASET = Path("data/public_set.jsonl")


def fake_state(card: dict, user_profile: dict, category: str, disclose: str) -> SessionState:
    values = [*card.get("hard_constraints", []), *card.get("soft_preferences", [])]
    if disclose == "first":
        values = values[:1]
    positive: dict[str, list[Constraint]] = {}
    for value in values:
        attribute = classify_constraint(value)
        positive.setdefault(attribute, []).append(
            Constraint(attribute, str(value).lower(), "positive", 1.0)
        )
    return SessionState(
        user_profile=user_profile,
        messages=[f"I'm looking for {category}."],
        parsed_messages=[],
        positive_constraints=positive,
        negative_constraints={},
        unconstrained_attributes=set(),
        disclosed_attributes=set(),
        asked_attributes=set(),
        last_recommendations=[],
        last_asked_attribute=None,
        query_text=" ".join(str(value).lower() for value in values),
        override_count=0,
    )


def main() -> None:
    ids, categories, products = catalog_index(_CATALOG)
    index = CandidateIndex(_CATALOG)
    samples = [json.loads(line) for line in _DATASET.read_text().splitlines() if line.strip()]

    for pool_size in (100, 200, 400):
        for disclose in ("first", "all"):
            overall = [0, 0]
            by_scenario: dict[str, list[int]] = defaultdict(lambda: [0, 0])
            for sample in samples:
                target = str(sample["ground_truth"]["parent_asin"])
                card = intent_card(products[target])
                category = coarse_category(categories.get(target, []))
                state = fake_state(card, sample["user_profile"], category, disclose)
                pool = {c.parent_asin for c in index.get_candidates(state, pool_size)}
                hit = int(target in pool)
                overall[0] += hit
                overall[1] += 1
                bucket = by_scenario[sample["scenario_type"]]
                bucket[0] += hit
                bucket[1] += 1
            breakdown = "  ".join(
                f"{name}={hits / total:.2f}" for name, (hits, total) in sorted(by_scenario.items())
            )
            print(
                f"pool={pool_size:<4} disclose={disclose:<5} "
                f"recall={overall[0] / overall[1]:.3f}   {breakdown}"
            )


if __name__ == "__main__":
    main()
