# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Participant starter kit for the **TechJam Conversational E-Commerce Search Challenge**. The
task: build a multi-turn shopping `Agent` that, given an anonymized `user_profile` and a
customer message, asks useful clarification questions and surfaces a hidden target product
(`parent_asin`) in its Top 10 within at most 10 turns. Ground truth is a real Amazon Reviews
2023 purchase; customer turns are simulated deterministically by the evaluator from a hidden
intent card — there are no real conversation logs.

Participants edit **only** `starter/agent.py`. `evaluator/` and the public labels are frozen
for scoring purposes and must not be modified when reporting a local score.

## Commands

```bash
# Run the full public-set evaluation (writes results.json, prints aggregate metrics)
python3 -m evaluator.local_evaluator

# The evaluator defaults to data/catalog.jsonl. The catalog ships at the repo root as
# catalog.jsonl, so either move it or pass the path explicitly:
mv catalog.jsonl data/catalog.jsonl
#   or
python3 -m evaluator.local_evaluator --catalog catalog.jsonl

# Other evaluator flags: --dataset data/public_set.jsonl  --output results.json

# Tests
python3 -m unittest discover -s tests
python3 -m unittest tests.test_evaluator                       # one module
python3 -m unittest tests.test_evaluator.EvaluatorTest.test_metric_summary_assigns_turn_11_to_miss  # one test
```

- **Python 3.10+**, standard library only. There is no `requirements.txt`, no build step,
  no linter configured. If the agent grows dependencies, add a manifest and document install
  steps (see `docs/submission_rules.md`).
- The catalog (`catalog.jsonl`, 50,000 rows, ~60 MB) is downloaded from the GitHub Release,
  not committed. `data/catalog.jsonl` is gitignored.

## Architecture

Three cooperating pieces, wired together in `evaluator/local_evaluator.py:main`:

1. **`starter/agent.py` — the `Agent`** (the only file you build). Contract:
   - `__init__(catalog_path)` — the evaluator constructs it with the catalog path; do index
     building here. The starter builds an in-memory SQLite FTS5 BM25 index.
   - `reset(session_id, user_profile)` — called once per session before any `respond`.
   - `respond(session_id, user_message, turn, top_k) -> dict` with keys `message` (str),
     `ask_attribute` (one of the allowed attributes or `None`), `recommendations` (list of
     `{"parent_asin": ...}`, best-first), and optional `usage` (`prompt_tokens`,
     `completion_tokens`). `top_k` is always 10.
   - Raised exceptions / malformed output are swallowed by the evaluator and scored as a miss
     for that turn (`local_evaluator.py:239`).

2. **`evaluator/local_evaluator.py` — harness + simulated customer + scorer.** Per session it:
   - Loads the catalog once into `catalog_index` → `(catalog_ids, categories, products)`.
   - Reconstructs the **hidden intent card and behavior** that the private set would carry but
     the public file omits — `materialize_hidden_fields` → `intent_card` / `behavior_for`.
     `intent_card` mines `title`, `features`, `details`, and regex-matched material/color/price
     from the target product to produce `target_category`, `hard_constraints`,
     `soft_preferences`. This derivation is deterministic (seeded by `sample_id`).
   - Drives up to 10 turns. `initial_message` sends a scenario-appropriate opener; after each
     agent turn `customer_reply` reveals *one* not-yet-disclosed constraint that matches the
     agent's `ask_attribute` (mapped via `classify_constraint`). Asking with `ask_attribute:
     None` or an attribute with nothing left to give yields a non-answer — question targeting
     matters.
   - `normalize_recommendations` keeps the first 10 unique IDs that exist in the catalog;
     everything else is dropped. A hit requires **exact `parent_asin` equality**.
   - Scenario handling: `intent_override` sessions **cannot** score a hit before the override
     message is delivered on turn 3 or 4 (`override_applied` gate); `boundary` sessions answer
     the first clarification with "no preference, use your judgment".

3. **`docs/` — the authoritative contract.** `competition_specification.md` (rules, scenario
   mix, session protocol), `agent_api_contract.json` (JSON Schema for reset/turn request +
   response — note `additionalProperties: false`), `evaluation_config.json` (scoring weights),
   `baseline_results.json` (reproducible weak-BM25 reference: HitRate@10 0.125, MRR 0.068,
   MTTC 9.81, TechnicalScore 0.107).

### Scoring

```
Efficiency     = clip((11 - MTTC) / 10, 0, 1)   # MTTC counts a miss as turn 11
TechnicalScore = 0.50·HitRate@10 + 0.30·MRR + 0.20·Efficiency
```

Metrics are also broken out per scenario (`buying`, `browsing`, `intent_override`,
`boundary`). Reported token usage and latency are feasibility signals only — they do not
move `TechnicalScore`.

### Scenario mix (both public and private splits)

40% Buying (hard constraint disclosed early) · 40% Browsing (starts vague) · 15% Intent
Override (a preference is replaced on turn 3–4) · 5% Boundary (no preference for a requested
attribute). Public set: 200 sessions (80/80/30/10).

## Data shape

- **Catalog row** (`catalog.jsonl`): agent-visible fields are `parent_asin`, `title`,
  `features` (list), `description` (list), `price` (may be `null`), `categories` (list),
  `details` (dict), `average_rating`, `rating_number`, `store`. Only `parent_asin` is scored.
- **Public session** (`data/public_set.jsonl`): `sample_id`, `scenario_type`, `user_profile`
  (aggregate only: `purchase_frequency`, `average_prior_rating`, `rating_style`,
  `preference_tags`, `summary`), `ground_truth.parent_asin`, plus `category_bucket` /
  `difficulty_bucket`. No intent card, no simulator internals — the evaluator derives those.

## Constraints from the rules (`docs/submission_rules.md`)

- Out of scope: catalog modification, IDs outside the frozen catalog, model training,
  multimodal, heavy vector-DB infra, real transactions, mandatory UI.
- Final scoring may run **offline with network disabled**. If the agent calls an LLM API,
  it must document that and ideally provide an offline fallback. API keys via env vars only,
  never committed.
- `.env`, `results.json`, `data/catalog.jsonl`, and `organizer/` are gitignored; `organizer/`
  and `secure/` are organizer-only and not present in this checkout.
