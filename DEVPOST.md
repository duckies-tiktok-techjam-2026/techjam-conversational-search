# Shopping Copilot

**A multi-turn shopping agent that turns a short conversation into a focused product shortlist.**

## What it does

Shopping Copilot asks one helpful follow-up question at a time, remembers the shopper's answers, and updates its recommendations as new details arrive. It also adapts when a shopper changes their mind mid-conversation, or has no preference for a detail we asked about.

## How it addresses the problem statement

Our core idea: **search using the shopper's exact wording**, not only a simplified summary of it.

- A broad request such as *"a men's T-shirt"* matches thousands of products.
- A detail like *"jersey knit"*, *"tagless"*, or *"4.3 oz"* is far more distinctive.
- Wording like this is what actually discriminates between near-identical listings — and a keyword parser with a fixed vocabulary throws it away.

### The pipeline (runs every turn)

| Stage | What it does |
| --- | --- |
| **1. Parse** | Extracts the things closed vocabularies handle well — material, colour, size, style, category, feature, use case, brand, budget — plus the conversational signals that change state: a preference being replaced, a "no preference" answer, or "not quite right" feedback. |
| **2. Fold** | Merges the result into per-session state, so every constraint disclosed so far stays available. |
| **3. Plan** | Builds a query combining the structured constraints with the shopper's verbatim phrases. |
| **4. Retrieve** | Pulls a candidate pool from a full-text index over the catalog, requiring *several* clues to match together rather than promoting an item because it matched one popular keyword. Rare clues (measured by how many catalog rows contain them) are trusted more, and the query relaxes step by step if nothing satisfies all of it. |
| **5. Rerank** | Scores the pool against everything said so far — exact-phrase hits, partial phrase coverage, field-weighted token overlap, attribute matches and rating — subtracting points for contradictions such as a wrong colour or a price over budget. A cross-encoder model then reorders the top of that list. |

### Handling the harder scenarios

- **A shopper replaces a preference** → we clear only the attribute being replaced, treat the old value as something to avoid, and ask a direct follow-up about the new one.
- **A shopper has no preference** → we record the attribute as unconstrained, so we do not ask again and do not penalise products for it.

### Asking the right question

Question choice matters as much as ranking, because what we ask determines what the shopper tells us next. We lead with the attribute most likely to produce a distinctive phrase, and fall back to an open-ended ask that broadly covers all categories.

## Built with

**Development tools**

- Python 3.10+ (standard library only for the retrieval and ranking core)
- Cursor and VS Code
- Git / GitHub
- `unittest` for the test suite, run locally from the CLI
- A Python virtual environment (`venv`) for the cross-encoder dependencies
- Our own measurement scripts, written for this project: candidate-pool recall, a paraphrase-robustness harness, a cross-encoder parameter sweep, and an interactive CLI for talking to the agent by hand

**Libraries and frameworks**

Retrieval and ranking core — *Python standard library only*:

- `sqlite3` with the **FTS5** extension: the in-memory BM25 full-text index over the catalog
- `json`, `re`, `dataclasses`, `unittest`

Second-stage reranker:

- **`sentence-transformers`** — the only third-party dependency, in `requirements.txt`
- **PyTorch**, installed transitively by `sentence-transformers`

No pandas, no scikit-learn, no vector database, no ML framework in the core.

**APIs used**

**None.** There are no LLM API calls and no external services. No network access is required at inference time — only at first startup, where the agent installs the reranker dependency if it is missing and downloads the model weights once, after which both are cached. If either step is unavailable, the agent degrades to the rule-based ranking instead of failing.

**Datasets and assets**

- The challenge's frozen **50,000-product catalog** (`catalog.jsonl`), used read-only
- The challenge's **public evaluation set** of 200 simulated shopping conversations
- **`cross-encoder/ms-marco-MiniLM-L-6-v2`** (~90 MB), a pre-trained relevance model from Hugging Face, used as-is for reranking
