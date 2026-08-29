# [CLAUDE.md](http://CLAUDE.md)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Participant starter kit for the **TechJam Conversational E-Commerce Search Challenge**. The
task: build a multi-turn shopping `Agent` that, given an anonymized `user_profile` and a
customer message, asks useful clarification questions and surfaces a hidden target product
(`parent_asin`) in its Top 10 within at most 10 turns. Ground truth is a real Amazon Reviews
2023 purchase; customer turns are simulated deterministically by the evaluator from a hidden
intent card — there are no real conversation logs.

Participants edit `starter/` only — the kit ships `starter/agent.py` plus a modular
`starter/components/` package that `agent.py` imports (see **Current status** below).
`evaluator/` and the public labels are frozen for scoring purposes and must not be modified
when reporting a local score.

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

1. `starter/agent.py` **— the** `Agent` (the only file you build). Contract:
  - `__init__(catalog_path)` — the evaluator constructs it with the catalog path; do index
   building here. The starter builds an in-memory SQLite FTS5 BM25 index.
  - `reset(session_id, user_profile)` — called once per session before any `respond`.
  - `respond(session_id, user_message, turn, top_k) -> dict` with keys `message` (str),
  `ask_attribute` (one of the allowed attributes or `None`), `recommendations` (list of
  `{"parent_asin": ...}`, best-first), and optional `usage` (`prompt_tokens`,
  `completion_tokens`). `top_k` is always 10.
  - Raised exceptions / malformed output are swallowed by the evaluator and scored as a miss
  for that turn (`local_evaluator.py:239`).
2. `evaluator/local_evaluator.py` **— harness + simulated customer + scorer.** Per session it:
  - Loads the catalog once into `catalog_index` → `(catalog_ids, categories, products)`.
  - Reconstructs the **hidden intent card and behavior** that the private set would carry but
  the public file omits — `materialize_hidden_fields` → `intent_card` / `behavior_for`.
  `intent_card` mines `title`, `features`, `details`, and regex-matched material/color/price
  from the target product to produce `target_category`, `hard_constraints`,
  `soft_preferences`. This derivation is deterministic (seeded by `sample_id`).
  - Drives up to 10 turns. `initial_message` sends a scenario-appropriate opener; after each
  agent turn `customer_reply` reveals *one* not-yet-disclosed constraint that matches the
  agent's `ask_attribute` (mapped via `classify_constraint`). Asking with `ask_attribute: None` or an attribute with nothing left to give yields a non-answer — question targeting
  matters.
  - `normalize_recommendations` keeps the first 10 unique IDs that exist in the catalog;
  everything else is dropped. A hit requires **exact** `parent_asin` **equality**.
  - Scenario handling: `intent_override` sessions **cannot** score a hit before the override
  message is delivered on turn 3 or 4 (`override_applied` gate); `boundary` sessions answer
  the first clarification with "no preference, use your judgment".
3. `docs/` **— the authoritative contract.** `competition_specification.md` (rules, scenario
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

## Current status (team build)

`starter/agent.py` is no longer the weak BM25 starter — it wires a five-stage
pipeline built from `starter/components/`. Ownership: **retrieval/indexing** (Person A), **constraints** = parser + session store (Person B), **rerank** (Person C).

Pipeline, per `respond`:

```
parse_message() -> SessionStore.update() -> build_search_plan()
    -> CandidateIndex.get_candidates(state) -> rerank(candidates, state, plan, products) -> Top 10
```

- `parser.py` — deterministic, vocab-list keyword extraction into `Constraint(attribute, value, polarity, confidence)`. Still **lossy** by design — discards message tokens not in
its fixed term tuples (`MATERIAL_TERMS`, `COLOR_TERMS`, `FEATURE_TERMS`, …), so the
discriminative parts of a disclosed snippet (`4.3`, `oz`, `jersey`, `tagless`) never reach
`positive_constraints`. Retrieval no longer depends on it for lexical matching (below); it
is now used for what it is good at — the closed vocabularies (material/color/brand) and the
`override` / `boundary` / `generic_feedback` flags.
- `session_store.py` — folds constraints across turns into `SessionState`; handles the
`override` (clear soft prefs, keep category) and `boundary` (mark attribute unconstrained)
transitions.
- `search_plan.py` — `build_search_plan(state) -> SearchPlan` with `required_terms`,
`optional_terms`, `excluded_terms`, `exact_phrases`, `attribute_values`.
- `retrieval.py` — `CandidateIndex`: builds an in-memory FTS5 index + a token
document-frequency table in `__init__`; `get_candidates(state, pool_size=200)` unions three
paths — rare-term AND per snippet, conjunctive core (AND all clues, drop least-selective
clause if too strict, broad-OR fallback), category/material includes — and returns
`Candidate(parent_asin, paths, path_ranks, fts_score, rrf_score)`, loosely ordered by
`(len(paths), rrf_score, fts_score)` where `rrf_score` is a weighted reciprocal-rank fusion
over per-path BM25 ranks (`rare_and` > `core` > `structured` > `category` > `bm25_all`).
Snippets come from
`_disclosure_snippets(state)`: the **verbatim** `parsed_messages[i].normalized_text` from the
last override onward, minus boilerplate (leading `I'm looking for …` opener, text before the
`:` lead-in) and minus no-information turns (`_NON_ANSWER_RE`: boundary answers, "no
additional preference", "not quite right"), split on `;` / sentence boundaries. `_rare_terms`
then picks what is actually selective by document frequency and drops `df == 0` tokens, which
would otherwise make their AND unsatisfiable. Path A relaxes 4-term AND → 2-term AND → OR
before giving up. Structured includes still read `positive_constraints` for
material/color/brand.
- `rerank.py` — `rerank(candidates, state, plan, products)` scores every pooled
`parent_asin` with the additive `score_product`. The carried retrieval signal is **not** the raw
BM25 magnitude (spread up to 224 points within one pool, which drowned every hand-crafted
signal and penalty); `rerank()` min-max normalizes `retrieval_score` across the pool to
[0, 1] and scales by `RETRIEVAL_WEIGHT = 9.0` before adding it. **+** bounded retrieval
prior, exact-phrase hits (title/features/details), field-weighted token overlap, per-attribute
containment (hard attributes > soft), preference-tag bonus, rating/review tie-break; **−**
excluded-term contradiction, color/material mismatch, budget violation (`maximum` over cap /
`around` off by >35%), and a demotion for items rejected after a "not quite right" turn.
`scripts/score_ablation.py` sweeps prior modes for tuning. `agent.py` wires the pool at
`CANDIDATE_POOL_SIZE = 150` and forwards `path_ranks` for optional RRF rerank experiments.
- `questions.py` — unchanged from the starter (static priority lists). Question targeting
drives what the simulator discloses, so this matters and is not yet tuned.
- `agent.py.__init__` makes **two** catalog passes (`_load_products` dict + `CandidateIndex`).
- Fully standard-library / offline; no LLM calls.

Dev tool: `python3 -m scripts.recall_check` — candidate-pool recall (is the target in the
pool?) over the public set. It replays the evaluator's own `initial_message` /
`customer_reply` turns through the real `parse_message` + `SessionStore`, so parser losses
are visible; the stand-in agent always asks `other` (never excluded by
`classify_constraint`), making these an upper bound over question policies only. Latest
(verbatim-snippet retrieval + RRF pool ordering): `pool=200` → **0.965** fully disclosed,
**0.600** with only the turn-1 message.

| pool | disclose | recall | boundary | browsing | buying | intent_override |
| ---- | -------- | ------ | -------- | -------- | ------ | --------------- |
| 100  | first    | 0.435  | 0.40     | 0.36     | 0.49   | 0.50            |
| 100  | all      | 0.930  | 1.00     | 0.96     | 0.96   | 0.73            |
| 200  | first    | 0.600  | 0.40     | 0.46     | 0.75   | 0.63            |
| 200  | all      | 0.965  | 1.00     | 1.00     | 0.97   | 0.83            |
| 400  | first    | 0.630  | 0.40     | 0.46     | 0.82   | 0.63            |
| 400  | all      | 0.980  | 1.00     | 1.00     | 0.99   | 0.90            |

Dev tool: `python3 -m scripts.score_ablation` — one Agent build, then re-runs the public-set
evaluator while mutating retrieval-prior knobs in `rerank.py`. Used to pick minmax w=9 over
raw (Hit@10 0.805 vs 0.790, buying 0.788 vs 0.738); RRF rerank did not beat minmax on
TechnicalScore, so RRF is pool-ordering only.

### Local score (2026-08-29, full public set, `python3 -m evaluator.local_evaluator`)

Aggregate: **HitRate@10 0.805 · MRR 0.405 · MTTC 4.58 · Efficiency 0.643 · TechnicalScore
0.652** (verbatim retrieval only 0.790 / 0.458 / 4.64 / 0.637 / 0.660; weak-BM25 baseline
0.125 / 0.068 / 9.81 / — / 0.107). Token usage 0 (pure stdlib). Run takes ~73s.

| Scenario        | n   | Hit@10 | MRR   | MTTC |
| --------------- | --- | ------ | ----- | ---- |
| boundary        | 10  | 0.800  | 0.494 | 4.50 |
| browsing        | 80  | 0.875  | 0.457 | 4.36 |
| buying          | 80  | 0.788  | 0.351 | 4.01 |
| intent_override | 30  | 0.667  | 0.379 | 6.67 |

Reads: bounding the retrieval prior (minmax × 9) lifted Hit@10 and **buying** (0.738 → 0.788)
at the cost of some MRR (0.458 → 0.405) — constraint signals and penalties can now move the
needle because the prior is capped at 9 points, not 224. RRF per-path ranks improved pool
truncation (`rare_and`-first) but RRF-as-rerank-prior did not beat minmax. `intent_override`
moved 0.600 → 0.667. Remaining headroom: `search_plan.exact_phrases` still carries turn
boilerplate on buying openers, so the +5 title phrase bonus rarely fires there.

Open items:

- Recompute the local score after any pipeline change; `results.json` from this run is the
current reference (still gitignored).
- Strip boilerplate from `exact_phrases_for_state` the way `_disclosure_snippets` does, so the
rerank phrase bonus fires on buying openers.
- Tune `questions.py` — `classify_constraint` catch-alls to `feature`, so asking `feature` /
`other` is usually the highest-yield.
- `CandidateIndex` build is ~40s and uncached; consider persisting the FTS DB + df table.



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

