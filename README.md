# TechJam Conversational E-Commerce Search Challenge

Build an AI shopping agent that asks useful follow-up questions and recommends the customer's hidden target product within at most 10 turns.

## What You Receive

- A frozen catalog of 50,000 products from the `Clothing_Shoes_and_Jewelry` category of Amazon Reviews 2023.
- 200 labeled public sessions for local development.
- A weak BM25 starter agent and deterministic local evaluator.
- The Agent API contract and scoring rules.

The organizer keeps 800 additional sessions private for final evaluation.

## Task

For each session, your agent receives an anonymized preference profile and a short customer message. Raw user IDs, review text, timestamps, and purchase history are never disclosed. On every turn the agent may:

- ask a natural clarification question in `message` and identify one requested field in `ask_attribute`;
- return a ranked list of up to 10 catalog `parent_asin` values;
- do both in the same response.

The session ends when the target product appears in the scored Top 10 or after turn 10. Sessions cover Buying, Browsing, Intent Override, and Boundary behavior.

## Download the Catalog

Download `catalog.jsonl.gz` from the GitHub Release attached to this repository, then run:

```bash
gzip -dk catalog.jsonl.gz
mv catalog.jsonl data/catalog.jsonl
```

Verify the downloaded file using the published `SHA256SUMS` file.

## Run the Starter

Python 3.10 or later is recommended. The starter uses only the Python standard library.

```bash
python3 -m evaluator.local_evaluator
```

Edit `starter/agent.py` to implement your system. Do not edit the evaluator or public labels when reporting your local score.
The command writes per-session results and aggregate metrics to `results.json`.

## Modular Agent Components

The evaluator imports `Agent` from `starter.agent`. The entry point coordinates the following standard-library components:

```text
starter/
    agent.py
    components/
        models.py          shared parser, session, and search-plan types
        parser.py          deterministic message parsing
        session_store.py   per-session state and override/boundary transitions
        search_plan.py    active state to retrieval inputs
        retrieval.py       catalog index + candidate-pool generation
        rerank.py          deterministic scoring of the candidate pool
        questions.py       clarification attribute selection
```

The component handoff is:

```text
customer message -> parse_message() -> SessionStore.update() -> build_search_plan()
    -> CandidateIndex.get_candidates(state) -> rerank() -> Agent response
```

`SearchPlan` exposes `required_terms`, `optional_terms`, `excluded_terms`, `exact_phrases`, and `attribute_values`. The parser and session store do not depend on SQLite or evaluator internals.

`retrieval.py` owns the **candidate pool**: `CandidateIndex` builds an in-memory SQLite FTS5 index plus a document-frequency table once in `__init__`, and `get_candidates(state, pool_size=200)` returns up to `pool_size` `Candidate` records by unioning several retrieval paths. Each candidate carries per-path BM25 ranks; pool truncation orders by weighted reciprocal-rank fusion (`rare_and` weighted highest) rather than raw BM25 magnitude.

Its lexical paths read the **verbatim** customer text (`parsed_messages[i].normalized_text`) rather than the parser's `Constraint` values, because the parser only keeps tokens from its fixed vocabularies and would drop the discriminative part of a disclosure (`4.3 oz`, `jersey knit`, `tagless`). `disclosure.py` takes the turns from the last override onward, strips boilerplate and no-information turns, and splits them into snippets; `_rare_terms` then selects the most selective tokens by document frequency. `positive_constraints` is still the source for structured material/color/brand includes.

`search_plan.py` builds the rerank inputs, including `exact_phrases`: the same stripped disclosure snippets (>=2 tokens, colon-normalized) so phrase bonuses match target `features`/`details` rather than dead boilerplate turn text.

`rerank.py` turns that pool into the final Top 10. `rerank(candidates, state, plan, products)` scores every pooled `parent_asin` with a deterministic additive model in `score_product` and returns them best-first. The retrieval contribution is a **pool-local min-max prior** scaled to at most 9 points; exact-phrase hits are scaled by `PHRASE_WEIGHT = 2.0`. Positive signals: bounded retrieval prior, exact-phrase hits against title/features/details, field-weighted token overlap, per-attribute containment (hard attributes weighted above soft ones), profile preference-tag bonuses, and a rating/review-count tie-break. Penalties: excluded-term contradictions, color/material mismatch, budget violations (`maximum` over cap, `around` off by more than 35%), and a feedback penalty that demotes items the customer rejected after a "not quite right" turn. It consumes the `SearchPlan`, the `SessionState`, and the in-memory catalog map that `agent.py` loads in `__init__`. `agent.py` wires the two together with `CANDIDATE_POOL_SIZE = 150` and remains responsible for response formatting.

Validate the package import and component tests with:

```bash
python -c "from starter.agent import Agent"
python -m unittest discover -s tests
```

Measure candidate-pool recall (does the pool contain the target?) with:

```bash
python3 -m scripts.recall_check
python3 -m scripts.score_ablation
python3 -m scripts.score_ablation --phrases
```

The frozen weak-BM25 reference scores Hit Rate@10 `0.125`, MRR `0.068034`, and
MTTC `9.81` on the released public set (`docs/baseline_results.json`) — the target
to beat, not the current pipeline. The current pipeline scores Hit Rate@10 `0.850`,
MRR `0.489`, MTTC `4.11`, Technical Score `0.710`.

## Agent Interface

```python
class Agent:
    def reset(self, session_id: str, user_profile: dict) -> None:
        ...

    def respond(self, session_id: str, user_message: str, turn: int, top_k: int) -> dict:
        return {
            "message": "Do you have a material preference?",
            "ask_attribute": "material",
            "recommendations": [
                {"parent_asin": "B000..."},
                {"parent_asin": "B001..."}
            ],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30}
        }
```

`ask_attribute` is one of `category`, `material`, `color`, `size`, `style`, `brand`, `budget`, `feature`, `use_case`, `other`, or `null`. See `docs/agent_api_contract.json`.

## Technical Metrics

- **Hit Rate@10:** fraction of sessions that find the target within 10 turns.
- **MRR:** mean reciprocal rank of the target; a miss contributes zero.
- **MTTC:** mean first-hit turn; a miss is assigned turn 11.
- **Reported token usage:** prompt and completion tokens returned by the team's model client.

```text
TechnicalScore = 0.50 × HitRate@10 + 0.30 × MRR + 0.20 × Efficiency
Efficiency = clip((11 - MTTC) / 10, 0, 1)
```

`TechnicalScore` is an objective input to the `Technical Execution` assessment. It is not a separate judging criterion and does not represent the entire `Technical Execution` score.

Only exact `parent_asin` equality produces a hit. Core metrics are also reported by scenario.

## Model Choice and Cost

Teams may use any legally accessible LLM API or local model. Teams manage their own credentials and must never commit API keys. Model choice, estimated cost, token usage, and latency must be disclosed. Token usage is a feasibility metric, not part of the core technical score. The organizer does not provide or reimburse model API credits; teams are responsible for any costs incurred through optional external services.

## Files

```text
data/public_set.jsonl             200 labeled development sessions
docs/competition_specification.md participant rules and evaluation protocol
docs/agent_api_contract.json      machine-readable Agent contract
docs/evaluation_config.json       scoring configuration
docs/baseline_results.json        reproducible weak-starter reference score
starter/agent.py                  editable weak starter
evaluator/local_evaluator.py      public-set simulator and scorer
```

## Judging and Submission Policy

- Participant submission requirements: `docs/submission_rules.md`
- Organizer-only final judging controls: `organizer/JUDGING_RUNBOOK.md`
- Organizer private release checklist: `organizer/private_release_checklist.md`
- Judging day operations SOP: `organizer/JUDGING_DAY_SOP.md`

## Data Source

The catalog and sessions are derived from Amazon Reviews 2023 by McAuley Lab, UCSD. See `DATA_ATTRIBUTION.md` before using or redistributing the data.
Sessions are sampled deterministically from the official Clothing 5-core leave-last-out split and joined to the frozen catalog.
