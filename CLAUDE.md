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
`optional_terms`, `excluded_terms`, `exact_phrases`, `attribute_values`, `snippet_terms`.
`exact_phrases` / `snippet_terms` are the verbatim disclosure snippets and their tokens
(`snippets.disclosure_snippets`), i.e. the same text retrieval searched on — not the parsed
constraints.
- `retrieval.py` — `CandidateIndex`: builds an in-memory FTS5 index + a token
document-frequency table in `__init__`; `get_candidates(state, pool_size=200)` unions three paths — rare-term AND per snippet, conjunctive core (AND all clues, drop least-selective clause if too strict, broad-OR fallback), category/material includes — and returns `Candidate(parent_asin, paths, fts_score)`, loosely ordered. Snippets come from
`snippets.disclosure_snippets(state)`: the **verbatim** `parsed_messages[i].normalized_text` from the last override onward, minus boilerplate (leading `I'm looking for …` opener, text before the`:` lead-in) and minus no-information turns (`NON_ANSWER_RE`: boundary answers, "no
additional preference", "not quite right"), split on `;` / sentence boundaries. `_rare_terms`
then picks what is actually selective by document frequency and drops `df == 0` tokens, which
would otherwise make their AND unsatisfiable. Path A relaxes 4-term AND → 2-term AND → OR
before giving up. Structured includes still read `positive_constraints` for
material/color/brand.
- `snippets.py` — shared by retrieval and rerank: `disclosure_snippets(state)` (above),
`tokens()`, and `category_from_opener()` (the single home for the opener regex —
`session_store` and `retrieval` both import it; there used to be three copies). Split out so
the query that *ranks* a candidate is the query that *found* it. The simulator quotes the
target's own `features` / `details` back at us, so a snippet is often a verbatim substring of
the target row — but note the `--authored-card` measurement below: that verbatim property is
**not** what the score rests on (rewording it costs 0.000). What the score rested on was the
*shape* of the phrasing — the `:` lead-in, the `I'm looking for` opener, the non-answer
wordings — which is why extraction now degrades instead of discarding: `_strip_lead_in` never
deletes a whole message, and `STOPWORDS` covers conversational scaffolding so meta words can't
reach `_rare_terms`.
- `rerank.py` — `rerank(candidates, state, plan, products)` scores every pooled
`parent_asin` with the additive `score_product`: **+** carried retrieval score, exact-phrase
hits (title/features/details; matched punctuation-insensitively via `_canonical`, since the
simulator writes a detail as `key: value` and `_field_map` flattens it to `key value`),
`_snippet_coverage` (per clue, `_COVERAGE_WEIGHT=6.0` × the share of its tokens found — partial
credit where the exact phrase is all-or-nothing, e.g. clues truncated at 180 chars),
field-weighted token overlap (required + snippet + optional terms), per-attribute containment (hard
attributes > soft), preference-tag bonus, rating/review tie-break; **−** excluded-term
contradiction, color/material mismatch, budget violation (`maximum` over cap / `around` off
by >35%), and a demotion for items rejected after a "not quite right" turn. `agent.py`
wires the pool at `CANDIDATE_POOL_SIZE = 150`.
- `questions.py` — unchanged from the starter (static priority lists). Question targeting
drives what the simulator discloses, so this matters and is not yet tuned.
- `agent.py.__init__` makes **two** catalog passes (`_load_products` dict + `CandidateIndex`).
- Fully standard-library / offline; no LLM calls.

Dev tools:

`python3 -m scripts.robustness_check [--ablate] [--limit N]` — does the score survive a
customer who phrases things differently? Monkeypatches the evaluator's module-level
`initial_message` / `customer_reply` / `materialize_hidden_fields` (nothing in `evaluator/` is
modified) and reports TechnicalScore for four conditions: baseline, `--paraphrase` (six
templates reworded), `--authored-card` (mined constraints rewritten as prose, `key: value`
shape and 180-char truncation removed), and both. `--ablate` scores each rewrite alone to
attribute the damage. See Open items for the results and what they changed.

`python3 -m scripts.recall_check` — candidate-pool recall (is the target in the
pool?) over the public set. It replays the evaluator's own `initial_message` /
`customer_reply` turns through the real `parse_message` + `SessionStore`, so parser losses
are visible; the stand-in agent always asks `other` (never excluded by
`classify_constraint`), making these an upper bound over question policies only. Latest
(re-run 2026-08-30, post-`7e7aa0e`): `pool=200` → **0.985** fully disclosed, **0.625** with only
the turn-1 message. Before the verbatim-snippet change the same harness read 0.860 / 0.575, so
feeding raw turn text recovered nearly all of the parser's recall loss. These numbers are a
property of retrieval only — the snippets-into-rerank change below does not touch them.

| pool | disclose | recall | boundary | browsing | buying | intent_override |
| ---- | -------- | ------ | -------- | -------- | ------ | --------------- |
| 100  | first    | 0.425  | 0.40     | 0.36     | 0.46   | 0.50            |
| 100  | all      | 0.935  | 1.00     | 0.96     | 0.96   | 0.77            |
| 200  | first    | 0.625  | 0.40     | 0.46     | 0.81   | 0.63            |
| 200  | all      | 0.985  | 1.00     | 1.00     | 0.99   | 0.93            |
| 400  | first    | 0.630  | 0.40     | 0.46     | 0.82   | 0.63            |
| 400  | all      | 0.990  | 1.00     | 1.00     | 0.99   | 0.97            |




### Local score (full public set, `python3 -m evaluator.local_evaluator`)

**Default pipeline — cross-encoder on (per `dc3622f`, 2026-08-31):**
**HitRate@10 0.965 · MRR 0.606 · MTTC 3.00 · Efficiency 0.801 · TechnicalScore 0.824.** This
is the reported number (matches `README.md`, `presentation/data.js`, `index.html`). Not
independently re-run in this checkout — needs `sentence-transformers` + the ~90 MB
`cross-encoder/ms-marco-MiniLM-L-6-v2` download; the local `results.json` (gitignored) still
holds the older rule-only run and should be regenerated with the cross-encoder active.

**Rule-only baseline — `TECHJAM_CROSS_ENCODER_DISABLE=1`:** HitRate@10 0.965 · MRR 0.586 ·
MTTC 2.99 · Efficiency 0.801 · TechnicalScore **0.8186** (2026-08-31, after the paraphrase-
robustness work in Open items; the pre-robustness figure was 0.8173, byte-identical to the old
committed `results.json`). Progression to this point (Hit / MRR / MTTC /
Eff / TS): 0.790 / 0.458 / 4.64 / 0.637 / 0.660 → 0.915 / 0.552 / 4.31 / 0.669 / 0.757 →
0.920 / 0.561 / 4.11 / 0.689 / 0.766 → 0.930 / 0.560 / 4.055 / 0.694 / 0.772 → 0.945 / 0.572 /
3.690 / 0.731 / 0.790 → 0.965 / 0.583 / 3.00 / 0.800 / 0.817 → 0.965 / 0.586 / 2.99 / 0.801 /
0.819; pre-pipeline 0.450 / 0.191 /
7.71 / 0.330 / 0.348; weak-BM25 baseline 0.125 / 0.068 / 9.81 / — / 0.107. Token usage 0.

**Offline path (resolved 2026-08-31):** with no network `Agent.__init__` → `warm_up()` now
degrades instead of raising. `_ensure_model` catches both a failed `pip install` and a failed
model load, prints a one-line warning to stderr via `_warn_unavailable`, and returns `False`,
so `enabled` is `False` and `boost_scores` passes the rule scores through. Verified end-to-end
with `PIP_NO_INDEX=1 HF_HUB_OFFLINE=1` and `sentence-transformers` absent: the agent constructs
and answers. A fully offline scoring run therefore scores the rule-only pipeline (0.819) rather
than failing.

Recent moves (oldest first):

- `0.660 → 0.757` — the `questions.py` clarification-policy rewrite (commit `81fd7cd`):
`EMPTY_INTENT_PRIORITY` / `ACTIVE_INTENT_PRIORITY` lead with `feature`, `other` appended as a terminal catch-all. Mostly `buying` (0.738 → 0.950).
- `0.757 → 0.766` — the override rework (commit `40c01e6`): `SessionStore._apply_override`
clears only the attribute(s) the customer is actually replacing (was: wipe everything but
`category`), demotes the replaced value to a `negative_constraint`, leaves the replaced
attribute *not* marked disclosed so `questions.py` can ask a direct follow-up, and `rerank`
applies a 1.5× `_override_boost` to the post-override exact-phrase score. Falls back to the
old full wipe when the override turn parses to nothing. Fires only on `override` turns, so
the other three scenarios are byte-identical.
- `0.766 → 0.772` — retrieval pool-ordering fix (commit `7e7aa0e`): `get_candidates` sorts the
pool cutoff by `(_PATH_TIER, path count, fts_score)` instead of `(path count, fts_score)`, so a
genuine conjunctive match (`core` / `rare_and`) can't be evicted from the 150-item pool by a
loosely-matched broad-OR hit (`category` / `bm25_all`) whose raw BM25 merely runs higher; plus
a single-term Path A snippet (bare override reply like "polyester") now falls back to a bare
term match instead of zero hits. Lifted `browsing` Hit 0.938 → 0.950 and `intent_override` Hit
0.800 → 0.833; `buying` / `boundary` byte-identical.
- `0.772 → 0.790` — rerank now reads the verbatim snippets (docs gaps 1–2): snippet extraction
moved to `components/snippets.py`; `exact_phrases_for_state` returns those snippets on *every*
turn instead of the whole boilerplate-laden message (which could never substring-match a field,
so the phrase bonus had been ~dead weight); `plan.snippet_terms` folded into `_token_overlap`;
`_canonical` punctuation-insensitive phrase matching; new `_snippet_coverage`. Contributions,
cumulative: phrases 0.778, + snippet terms 0.783, + coverage 0.790. `_COVERAGE_WEIGHT` is flat
over ~5–12 and degrades at 20; ships at 6.0. Zeroing `_phrase_score` on top of coverage costs
0.009, so both terms earn their place. Lifted `boundary` Hit 0.900 → 1.000, `browsing` 0.950 →
0.975; `intent_override` unmoved.
- `0.790 → 0.817` — "Enhancement to score" (commit `c658e74`): three changes bundled —
(1) `snippets.py` / `search_plan.py` no longer hard-cut everything before an override turn, so
rerank keeps the still-valid pre-override clues (docs gap 3, previously flagged as the next
target); (2) turn-aware question selection in `questions.py`; (3) a category-mismatch penalty in
`rerank.score_product`; plus a `session_store.py` field. This is the move that closed
`intent_override`: Hit 0.833 → 0.967, MRR 0.619 → 0.690, MTTC 5.43 → 4.10. MTTC also dropped
across the other three (aggregate 3.69 → 3.00).
- (no score change at the time) `15636a9` adds a **cross-encoder second stage** —
`starter/components/cross_encoder_rerank.py`, `requirements.txt` (`sentence-transformers`).
Introduced as **opt-in** (`TECHJAM_CROSS_ENCODER_RERANK=1`) with a graceful offline fallback:
missing dep or model → `enabled` is `False` and `boost_scores` returns the rule scores
untouched. `scripts/cross_encoder_sweep.py` tunes `TECHJAM_CROSS_ENCODER_TOP_N` / `_WEIGHT`
(swept defaults: top_n 15, weight 2.0; `final = rule_score + 2.0·ce_score` over the top 15).
- `0.817 → ≈0.824` — `dc3622f` (2026-08-31) makes the cross-encoder **compulsory**. Removes the
`RERANK` opt-in so every evaluator run uses it; `Agent.__init__` calls `warm_up()` which
`_ensure_model(required=True)` — on missing dep it runs `pip install -r requirements.txt`.
`TECHJAM_CROSS_ENCODER_DISABLE=1` opts out, for baseline comparison. Effect (per `README.md` /
`presentation/data.js`, not re-run here): MRR ≈0.583→0.606, TechnicalScore ≈0.817→0.824,
Hit@10 unchanged (ordering-only stage). **Superseded 2026-08-31:** this commit also made a
failed install or model load **raise `RuntimeError`**, which would have failed `Agent.__init__`
outright on a network-disabled scoring run. `_ensure_model` now catches both and returns
`False` via `_warn_unavailable`, so the `enabled` / `cross_encoder=None` fallback carries the
offline path (0.819) instead of the run dying.


Per scenario (default, cross-encoder on — `Hit@10 / MRR / MTTC`, with the `DISABLE=1`
rule-only figure alongside):

| Scenario        | n   | Hit@10 | MRR   | MTTC | (rule-only)          |
| --------------- | --- | ------ | ----- | ---- | -------------------- |
| boundary        | 10  | 1.000  | 0.555 | 3.80 | 1.000 / 0.613 / 4.00 |
| browsing        | 80  | 0.975  | 0.588 | 2.98 | 0.975 / 0.567 / 2.96 |
| buying          | 80  | 0.950  | 0.569 | 2.50 | 0.950 / 0.554 / 2.50 |
| intent_override | 30  | 0.967  | 0.765 | 4.10 | 0.967 / 0.690 / 4.10 |


Reads: the cross-encoder is an ordering-only stage — Hit@10 is identical to the rule-only run
in every scenario; it moves MRR. Biggest lift is `intent_override` (MRR 0.690 → 0.765), which
now has the *highest* MRR of the four. `buying` (Hit 0.950, MRR 0.569) is the low scenario on
MRR. Remaining headroom overall is still MRR: 0.606 against a 0.965 hit rate means targets
land mid-list, not at rank 1 — and Hit@10 is close to its ceiling.

Open items:

- **Regenerate `results.json` with the cross-encoder on.** The local file (gitignored) is still
the pre-`dc3622f` rule-only run; the 0.824 aggregate above is sourced from `README.md` /
`presentation/data.js`, not from a run in this checkout.
- Recompute the local score after any pipeline change; `results.json` from the latest run is the
current reference (still gitignored).
- **Paraphrase exposure is now measured, and the surprise is which half mattered.**
`python3 -m scripts.robustness_check` (rule-only, 200 sessions) perturbs the simulator two
independent ways and reports the cost:
  - `--authored-card` — reword the mined constraints into prose, drop the `key: value` shape
  and the mid-word 180-char truncation: **0.000**. The pipeline does *not* actually depend on
  the public set's verbatim-quoting property; token overlap and `_snippet_coverage` carry it,
  so `_phrase_score` / `_COVERAGE_WEIGHT` / the evaluator-identical `MATERIAL_TERMS`
  `COLOR_TERMS` are far more robust than `snippets.py`'s own docstring implies. Widening those
  lexicons was measured as pointless and deliberately not done.
  - `--paraphrase` — reword the six customer templates: **−0.243 before the fix, −0.048 after.**
  `--ablate` attributes it. Three literal-dependencies in `snippets.py` did the damage:
  (1) `elif index == 0: continue` discarded the *entire turn-1 disclosure* whenever the lead-in
  had no colon; (2) meta words ("what matters there is…") leaked into the query, where
  `_rare_terms` ANDs a low-`df` word like "matters" and matches nothing; (3) `NON_ANSWER_RE`
  missed reworded non-answers, letting a content-free turn pollute the query. Fixed by removing
  the literal dependence, not by adding literals: one shared `_OPENER_LEAD` feeding both
  `OPENER_RE` and `CATEGORY_OPENER_RE`, `_strip_lead_in` (never deletes a whole message),
  `category_from_opener` with a first-clause fallback (now the single home for the opener regex
  — `session_store` and `retrieval` import it, was three copies), a broadened `NON_ANSWER_RE`,
  and ~45 conversational scaffolding words in `STOPWORDS`. Public set went 0.8173 → **0.8186**.
  Locked in by `tests/test_paraphrase_robustness.py` (each assertion pairs a simulator-exact
  phrasing with a reworded one). Caveat: the harness preserves content words, so −0.048 is a
  lower bound, and it is rule-only — cross-encoder behaviour under paraphrase is unmeasured.
- **Catalog statistics are barely mined.** All ten fields are read (FTS columns + rerank
`_FIELD_WEIGHTS` + price + rating), but the only structure derived from 50,000 rows is
`CandidateIndex.df` — and `doc_count` (`retrieval.py:57,:83`) is incremented and **never read**,
so no IDF exists anywhere. `_token_overlap` / `_snippet_coverage` weight every matched token
equally ("cotton" == "tagless"). Passing `df` / `doc_count` into rerank and weighting hits by
`log(doc_count / df[token])` is the cheapest remaining MRR move — the table is already in
memory, and unlike `_phrase_score` it is provenance-independent. Larger, unstarted: a facet
index over `details` dict keys, `categories` as a taxonomy rather than a token bag, per-category
price distributions, a brand vocabulary from `store`.
- `buying` MRR 0.569 is the weakest per-scenario number — targets are in the Top 10 (Hit
0.950) but land mid-list. Aggregate MRR (0.606) is the main headroom now that Hit@10 is near
ceiling.
- `_quality_tiebreak` and the raw carried `retrieval_score` have never been sensitivity-checked
against the (now much larger) snippet signals — cheap experiment, docs gap 6.
- The "avoid repeated asks" guard in `choose_question_attribute` only re-adds
`last_asked_attribute` to `excluded` when it is *already* excluded — currently a no-op.
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

