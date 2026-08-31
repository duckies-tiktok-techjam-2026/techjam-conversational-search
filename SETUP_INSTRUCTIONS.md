# Setup Instructions (Draft)

Temporary setup guide for local development and submission. Copy relevant sections into `README.md` and Devpost when ready.

---

## Requirements

- **Python 3.10+**
- **Catalog:** `data/catalog.jsonl` (50,000 products — not committed to git)
- **Python packages:** `sentence-transformers` (installed automatically on first agent startup if missing)

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

## 2. Install and run evaluation

The agent pipeline always includes a cross-encoder second stage. On first run, missing
Python packages and model weights (~90 MB) are fetched automatically.

```bash
# From repo root — one command after the catalog is in place
python3 -m evaluator.local_evaluator
```

Optional one-time install (skips the auto-pip step on first startup):

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Run the test suite:

```bash
python3 -m unittest discover -s tests
```

This evaluates **all 200 public sessions** against the full catalog and writes `results.json`.

**Expected score (rule-based + cross-encoder, top_n=15, weight=2.0):** run locally after setup and compare `recommended_technical_score` in `results.json`.

---

## 3. Cross-encoder tuning knobs

These environment variables adjust the built-in cross-encoder stage (no enable flag required):

| Variable | Default | Description |
|----------|---------|-------------|
| `TECHJAM_CROSS_ENCODER_TOP_N` | `15` | Number of top rule-scored candidates to rescore |
| `TECHJAM_CROSS_ENCODER_WEIGHT` | `2.0` | How much cross-encoder score is added (tuned via quick sweep) |
| `TECHJAM_CROSS_ENCODER_DISABLE` | off | Set to `1` to run rule-only (baseline comparisons only) |

Example with explicit overrides:

```bash
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

Confirm the best config on the **full 200 sessions** before submitting.

---

## 4. Other useful commands

```bash
# Candidate pool recall (retrieval only, not full agent score)
python3 -m scripts.recall_check

# Single test module
python3 -m unittest tests.test_rerank
```

Unit tests disable the cross-encoder via `TECHJAM_CROSS_ENCODER_DISABLE=1` so they stay fast and offline-friendly.

---

## 5. What not to commit

- `data/catalog.jsonl` (gitignored — download separately)
- `.venv/`
- `results.json`
- Hugging Face model cache (`~/.cache/huggingface/`)
- API keys or `.env`

---

## 6. For Devpost / submission report (copy-paste starter)

**Development tools:** Python 3.10+, venv, Cursor/VS Code

**Libraries:**
- `sentence-transformers` — cross-encoder rerank (required)
- PyTorch — dependency of sentence-transformers

**Model:**
- `cross-encoder/ms-marco-MiniLM-L-6-v2` — pretrained on MS MARCO; not fine-tuned on competition data; downloaded automatically on first run

**Pipeline:** FTS5 retrieval + structured rule rerank + cross-encoder second stage on the top 15 candidates.

**Network:** Required once for dependency install and model download; subsequent runs are offline if the model cache is warm. With no network and no cache the agent still constructs and scores — the cross-encoder stage is skipped with a warning and the rule-only ranking is used (TechnicalScore 0.819 instead of 0.824).

**Limitations:**
- Cross-encoder weight/top_n tuned on public quick sweep; private 800 sessions may differ

---

## 7. Reproduce reported scores

```bash
python3 -m evaluator.local_evaluator
```

Compare `recommended_technical_score` in terminal output or `results.json`.
