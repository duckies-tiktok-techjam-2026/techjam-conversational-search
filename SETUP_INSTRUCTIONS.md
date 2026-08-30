# Setup Instructions (Draft)

Temporary setup guide for local development and submission. Copy relevant sections into `README.md` and Devpost when ready.

---

## Requirements

- **Python 3.10+**
- **Catalog:** `data/catalog.jsonl` (50,000 products — not committed to git)

---

## 1. Get the catalog

Download `catalog.jsonl.gz` from the [participant kit release](https://github.com/TechJam2026/techjam-conversational-search/releases/tag/participant-kit), or unzip if you already have it locally:

```bash
cd data
unzip -o catalog.jsonl.zip
cd ..
```

Verify: `wc -l data/catalog.jsonl` should show `50000`.

---

## 2. Default setup (rule-based, offline)

No extra packages. Uses Python standard library + optional `sentence-transformers` only if enabled.

```bash
# From repo root
python3 -m unittest discover -s tests
python3 -m evaluator.local_evaluator
```

This evaluates **all 200 public sessions** against the full catalog and writes `results.json`.

**Expected baseline (rule-only, cross-encoder off):** TechnicalScore ~0.817

---

## 3. Optional: cross-encoder rerank

Adds a second-stage reranker using `cross-encoder/ms-marco-MiniLM-L-6-v2` (via `sentence-transformers`). Improves MRR by scoring `(customer query, product)` pairs jointly on the top 15 rule-scored candidates.

### Install

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

pip install -r requirements-cross-encoder.txt
```

First run downloads the model (~90 MB) from Hugging Face. Network required once for download.

### Run eval with cross-encoder

```bash
TECHJAM_CROSS_ENCODER_RERANK=1 python3 -m evaluator.local_evaluator
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TECHJAM_CROSS_ENCODER_RERANK` | off | Set to `1` to enable cross-encoder rerank |
| `TECHJAM_CROSS_ENCODER_TOP_N` | `15` | Number of top rule-scored candidates to rescore |
| `TECHJAM_CROSS_ENCODER_WEIGHT` | `2.0` | How much cross-encoder score is added (tuned via quick sweep) |

Example with explicit overrides:

```bash
TECHJAM_CROSS_ENCODER_RERANK=1 \
TECHJAM_CROSS_ENCODER_TOP_N=15 \
TECHJAM_CROSS_ENCODER_WEIGHT=2.0 \
python3 -m evaluator.local_evaluator
```

### Tune parameters (optional)

Quick sweep on 50 sessions (~15–30 min):

```bash
python3 -m scripts.cross_encoder_sweep --mode quick
```

Results saved to `cross_encoder_sweep_results.json`. Resume after interrupt:

```bash
python3 -m scripts.cross_encoder_sweep --mode quick --resume
```

Confirm the best config on the **full 200 sessions** before submitting with cross-encoder enabled.

---

## 4. Offline fallback (for final / no-network eval)

If **any** of the following is true, the agent runs **rule-based only** (no cross-encoder):

- `TECHJAM_CROSS_ENCODER_RERANK` is unset or not `1`
- `sentence-transformers` is not installed
- Model download fails

No code changes needed — same `python3 -m evaluator.local_evaluator` command works.

---

## 5. Other useful commands

```bash
# Candidate pool recall (retrieval only, not full agent score)
python3 -m scripts.recall_check

# Single test module
python3 -m unittest tests.test_rerank
```

---

## 6. What not to commit

- `data/catalog.jsonl` (gitignored — download separately)
- `.venv/`
- `results.json`
- Hugging Face model cache (`~/.cache/huggingface/`)
- API keys or `.env`

---

## 7. For Devpost / submission report (copy-paste starter)

**Development tools:** Python 3.10+, venv, Cursor/VS Code

**Libraries (optional path):**
- `sentence-transformers` — cross-encoder rerank
- PyTorch — dependency of sentence-transformers

**Model (optional):**
- `cross-encoder/ms-marco-MiniLM-L-6-v2` — pretrained on MS MARCO; not fine-tuned on competition data

**Default path:** Rule-based retrieval (FTS5) + structured rerank. No network, no GPU required.

**Optional path:** Cross-encoder second stage. Requires `pip install -r requirements-cross-encoder.txt` and `TECHJAM_CROSS_ENCODER_RERANK=1`. Slower (~5–15× eval time on CPU).

**Limitations:**
- Cross-encoder weight/top_n tuned on public quick sweep; private 800 sessions may differ
- Rule-only fallback always available for offline scoring

---

## 8. Reproduce reported scores

```bash
# Rule-only (recommended offline submission path)
python3 -m evaluator.local_evaluator

# With cross-encoder (optional)
pip install -r requirements-cross-encoder.txt
TECHJAM_CROSS_ENCODER_RERANK=1 python3 -m evaluator.local_evaluator
```

Compare `recommended_technical_score` in terminal output or `results.json`.
