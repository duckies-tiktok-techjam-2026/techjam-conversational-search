"""Offline recall harness for the candidate pool.

Isolates the pool from the *question policy* but not from the parser: customer
turns are replayed with the evaluator's own ``initial_message`` /
``customer_reply`` (driven by the hidden ``intent_card``), then folded into
``SessionState`` through the real ``parse_message`` + ``SessionStore``. So the
state handed to ``get_candidates`` is exactly what the agent would see — losses
in the parser show up in these numbers.

The stand-in agent always asks ``other``, which ``classify_constraint`` never
excludes, so disclosure is as fast as any policy could make it: recall here is
an upper bound over question policies, not over parsers.

    python3 -m scripts.recall_check
"""

from __future__ import annotations

import json
from collections import defaultdict
from copy import deepcopy
from pathlib import Path

from evaluator.local_evaluator import (
    MAX_TURNS,
    catalog_index,
    coarse_category,
    customer_reply,
    initial_message,
    materialize_hidden_fields,
)
from starter.components.models import SessionState
from starter.components.parser import parse_message
from starter.components.retrieval import CandidateIndex
from starter.components.session_store import SessionStore

_CATALOG = Path("data/catalog.jsonl") if Path("data/catalog.jsonl").exists() else Path("catalog.jsonl")
_DATASET = Path("data/public_set.jsonl")
_ASK_ATTRIBUTE = "other"


def replay(sample: dict, products: dict[str, dict], category: str) -> tuple[SessionState, SessionState]:
    """Replay a full simulated session; return the state after turn 1 and after the last turn."""
    card, behavior = materialize_hidden_fields(sample, products)
    effective = {**sample, "intent_card": card, "behavior": behavior}
    store = SessionStore()
    state = store.reset(str(sample["sample_id"]), sample["user_profile"])

    disclosed: set[str] = set()
    boundary_used = False
    override_applied = sample["scenario_type"] != "intent_override"
    message = initial_message(effective, category, disclosed)
    first_turn_state: SessionState | None = None

    for turn in range(1, MAX_TURNS + 1):
        store.update(state, message, parse_message(message))
        if turn == 1:
            first_turn_state = deepcopy(state)
        if turn == MAX_TURNS:
            break
        store.mark_question(state, _ASK_ATTRIBUTE)
        override = behavior.get("override") or {}
        if not override_applied and turn + 1 == int(override.get("turn", 3)):
            override_applied = True
            new_value = str(override.get("new_value", ""))
            if new_value:
                disclosed.add(new_value)
            message = str(override.get("message", "Actually, please ignore my earlier preference."))
        else:
            message, boundary_used = customer_reply(
                effective, _ASK_ATTRIBUTE, disclosed, boundary_used
            )

    assert first_turn_state is not None
    return first_turn_state, state


def main() -> None:
    _, categories, products = catalog_index(_CATALOG)
    index = CandidateIndex(_CATALOG)
    samples = [json.loads(line) for line in _DATASET.read_text().splitlines() if line.strip()]

    replays = []
    for sample in samples:
        target = str(sample["ground_truth"]["parent_asin"])
        category = coarse_category(categories.get(target, []))
        first_state, final_state = replay(sample, products, category)
        replays.append((sample, target, {"first": first_state, "all": final_state}))

    for pool_size in (100, 200, 400):
        for disclose in ("first", "all"):
            overall = [0, 0]
            by_scenario: dict[str, list[int]] = defaultdict(lambda: [0, 0])
            for sample, target, states in replays:
                pool = {c.parent_asin for c in index.get_candidates(states[disclose], pool_size)}
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
