# Shopping Copilot: AI Conversational Search and Recommendations

**TikTok TechJam 2026 Submission**: **Team Duckiesss**

A conversational shopping agent that asks the right follow-up questions and narrows a
50,000-product catalog down to the customer's intended item within a few turns.

---

## Project Overview

The agent holds a short back-and-forth with a shopper: it reads their preference profile
and opening message, asks one clarifying question at a time, and returns a ranked shortlist
of products that it refines as more is revealed. It handles shoppers who know exactly what
they want, shoppers who start vague, shoppers who change their mind mid-conversation, and
shoppers who have no opinion on something it asked about.

Our approach combines a **rule-based retrieval and rerank core** with a **built-in cross-encoder
second stage** — no LLM calls, no model training, no vector database. Dependencies and model
weights download automatically on first startup; subsequent runs are offline-friendly once
the Hugging Face cache is warm.

### Approach

Each customer turn flows through a five-stage pipeline:

```text
customer message
  -> parse            pull out stated preferences (material, colour, budget, features, ...)
  -> update state     merge with earlier turns; handle changes of mind and "no preference"
  -> plan search      turn the current state into search terms and quoted phrases
  -> retrieve         pull a few hundred candidates from a local keyword index
  -> rerank           score each candidate against everything known -> Top 10
```

Key design decisions:

- **Search on the customer's own words, not a parsed summary.** Shoppers tend to quote
specific phrases from the product they want ("4.3 oz", "jersey knit", "tagless"). We keep
that raw text and use it directly for both retrieval and ranking, instead of first
distilling it into a fixed set of attributes that would throw those distinctive phrases
away.
- **Trust precise matches over popular ones.** A product that matches several stated
requirements at once is kept ahead of one that merely scores high on a single common
word, so the true target is never pushed out of the shortlist by a loose keyword hit.
- **Track how the conversation changes.** When a shopper revises a preference, we replace
only that preference and remember what they rejected; when they say they have no opinion
on something, we stop asking about it.
- **Ask the question that reveals the most.** The shopper only volunteers information that
answers what we asked, so choosing the next question well is as important as ranking. The
agent follows a priority order that front-loads the most discriminating attributes.
- **Cross-encoder second stage.** A pretrained cross-encoder
(`cross-encoder/ms-marco-MiniLM-L-6-v2`) re-scores the top rule-ranked candidates against
the customer query on every turn. Model weights download automatically on first agent
startup (~90 MB).



### Results (local public set, 200 sessions)

Rule-based retrieval + cross-encoder rerank, `python3 -m evaluator.local_evaluator`:


| Metric                     | Score     | Rule-only | Weak-BM25 baseline |
| -------------------------- | --------- | --------- | ------------------ |
| Hit Rate@10                | **0.965** | 0.965     | 0.125              |
| MRR                        | **0.606** | 0.583     | 0.068              |
| MTTC (mean first-hit turn) | **3.00**  | 3.00      | 9.81               |
| Efficiency                 | **0.801** | 0.800     | —                  |
| **Technical Score**        | **0.824** | 0.817     | 0.107              |


`TechnicalScore = 0.50 · HitRate@10 + 0.30 · MRR + 0.20 · Efficiency`,
`Efficiency = clip((11 − MTTC) / 10, 0, 1)`. Reported token usage is `0` (no LLM calls).
A full run takes roughly 90 seconds on a laptop with the cross-encoder enabled (~45 seconds
rule-only via `TECHJAM_CROSS_ENCODER_DISABLE=1`).

Per scenario:


| Scenario        | n   | Hit@10 | MRR   | MTTC |
| --------------- | --- | ------ | ----- | ---- |
| boundary        | 10  | 1.000  | 0.555 | 3.80 |
| browsing        | 80  | 0.975  | 0.588 | 2.98 |
| buying          | 80  | 0.950  | 0.569 | 2.50 |
| intent_override | 30  | 0.967  | 0.765 | 4.10 |


---



## Setup and Installation

**Requirements:** Python 3.10+. First run installs `sentence-transformers` automatically if
missing and downloads the cross-encoder model weights (~90 MB).

### 1. Clone and enter the repo

```bash
git clone https://github.com/duckies-tiktok-techjam-2026/techjam-conversational-search.git
cd techjam-conversational-search
```



### 2. Get the catalog

The catalog (`catalog.jsonl`, 50,000 rows, ~60 MB) is not committed. Download
`catalog.jsonl.gz` from the GitHub Release attached to the repository, then:

```bash
gzip -dk catalog.jsonl.gz
mkdir -p data
mv catalog.jsonl data/catalog.jsonl
```

Verify: `wc -l data/catalog.jsonl` should print `50000`. Check the file against the published
`SHA256SUMS` if provided.

### 3. (Optional) Pre-install dependencies

Skip the auto-pip step on first startup:

```bash
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

The first enabled run downloads `cross-encoder/ms-marco-MiniLM-L-6-v2` (~90 MB) from
Hugging Face; network is required once for that download only.

---



## Steps to Reproduce Our Results

All commands run from the repo root.

### Run the test suite

```bash
python3 -m unittest discover -s tests
```



### Reproduce the reported Technical Score

```bash
python3 -m evaluator.local_evaluator
```

This evaluates all 200 public sessions against the full catalog and writes per-session
results plus aggregate metrics to `results.json`. The pipeline always runs the
cross-encoder second stage; on first startup missing dependencies and model weights are
fetched automatically (~90 MB from Hugging Face).

Optional one-time install before the first run:

```bash
pip install -r requirements.txt
```

The evaluator and public labels are unmodified.


| Environment variable            | Default | Purpose                                              |
| ------------------------------- | ------- | ---------------------------------------------------- |
| `TECHJAM_CROSS_ENCODER_TOP_N`   | `15`    | number of top rule-ranked candidates to rescore      |
| `TECHJAM_CROSS_ENCODER_WEIGHT`  | `2.0`   | weight applied to the cross-encoder score            |
| `TECHJAM_CROSS_ENCODER_DISABLE` | off     | set to `1` for rule-only baseline comparisons only   |

### Inspect retrieval quality in isolation

```bash
python3 -m scripts.recall_check
```

Reports candidate-pool recall (is the target product in the pool at all?) over the public
set, independent of ranking and question policy.

---



## Limitations and Future Improvements

- **MRR is the main headroom.** A 0.965 Hit Rate against a 0.583 MRR means targets land
reliably in the Top 10 but often mid-list rather than at rank 1. The additive rerank
weights (`_COVERAGE_WEIGHT`, the carried retrieval score, the quality tie-break) were tuned
by hand on the public set and have not been jointly optimized. A principled fit — or a
learned ranker over the deterministic features — is the most promising next step.
- **The parser is lossy by design.** It only keeps tokens from fixed vocabularies
(material, color, brand, feature). We worked around this by feeding verbatim text into
retrieval and rerank, but structured constraint handling (budget parsing, size
normalization, negation scope) is still shallow and occasionally misclassifies a turn.
- **Intent Override still discards valid context.** Snippet extraction hard-cuts everything
before the override turn, so pre-override clues that remain valid are dropped from both
retrieval and rerank. Carrying forward the non-replaced constraints explicitly would
recover MTTC on this scenario.
- **Question policy is static.** Clarification attributes come from fixed priority lists,
not from what would actually be most discriminating given the current candidate pool.
An information-gain-based selector (which attribute best splits the remaining candidates?)
should reduce turns to first hit.
- **Cross-encoder generalization is unverified.** Its weight and `top_n` were tuned on a
public quick sweep; the private 800-session split may behave differently.
- **Index build is uncached.** `CandidateIndex.__init__` rebuilds the FTS5 index and
document-frequency table on every startup (~40 s). Persisting them would make iteration
and cold starts much faster.
- **No true semantic retrieval.** Everything lexical is BM25 / FTS5. Paraphrased
constraints that share no tokens with the catalog row are only caught if the candidate
already made the pool and the cross-encoder can score it.

---



## Team Member Contributions


| Member             | Area                        | Contribution                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rayson Yap**     | Stateful conversation model | Built `session_store.py` and the multi-turn `SessionState` fold, including the Intent Override and Boundary transitions, and the `questions.py` clarification-attribute policy that drives what the simulated customer discloses.                                        |
| **Puah Tze Foong** | Retrieval                   | Built `retrieval.py`, `snippets.py`, and `search_plan.py` — the in-memory FTS5 BM25 index, the document-frequency rare-term selection, and the specificity-ranked union of retrieval paths that produces the candidate pool from verbatim customer text.                 |
| **Brian Chan**     | Ranking                     | Built `rerank.py`, the additive deterministic scoring model (exact-phrase and snippet-coverage bonuses, per-attribute containment, budget and mismatch penalties, feedback demotion), and the built-in `cross_encoder_rerank.py` second stage. |


---



## Model Choice and Cost

- **Default path:** rule-based retrieval (SQLite FTS5) + deterministic additive rerank +
cross-encoder rescore of the top 15 candidates. No LLM. First run needs network for
dependency/model download; token usage stays `0`.
- **Model:** `cross-encoder/ms-marco-MiniLM-L-6-v2` — pretrained on MS MARCO, not
fine-tuned on competition data. Adds ~5–15× evaluation time on CPU versus rule-only.
Set `TECHJAM_CROSS_ENCODER_DISABLE=1` only for baseline comparisons.

No API keys are used or committed.

---



## Repository Layout

```text
starter/agent.py                  agent entry point (response formatting + pipeline wiring)
starter/components/
    models.py                     shared parser / session / search-plan types
    parser.py                     deterministic message parsing
    session_store.py              per-session state; override / boundary transitions
    search_plan.py                active state -> retrieval inputs
    snippets.py                   verbatim disclosure-snippet extraction (shared)
    retrieval.py                  FTS5 index + candidate-pool generation
    rerank.py                     deterministic candidate scoring
    cross_encoder_rerank.py       built-in neural second stage (always on by default)
    questions.py                  clarification-attribute selection
evaluator/local_evaluator.py      public-set simulator and scorer (frozen)
data/public_set.jsonl             200 labeled development sessions
scripts/recall_check.py           candidate-pool recall diagnostic
tests/                            component unit tests
docs/                             competition contract, scoring config, baseline
```



## Data Source

The catalog and sessions are derived from Amazon Reviews 2023 by McAuley Lab, UCSD. See
`DATA_ATTRIBUTION.md` before using or redistributing the data. Sessions are sampled
deterministically from the official Clothing 5-core leave-last-out split and joined to the
frozen catalog.