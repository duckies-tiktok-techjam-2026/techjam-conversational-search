"""Ablation harness for retrieval-prior modes in the reranker.

Builds one Agent (one catalog index), then re-runs the public-set evaluator
while mutating module-level knobs in ``starter.components.rerank``.

    python3 -m scripts.score_ablation
    python3 -m scripts.score_ablation --quick   # skip raw control + prior-only
"""

from __future__ import annotations

import argparse
from pathlib import Path

from evaluator.local_evaluator import catalog_index, evaluate, load_jsonl
from starter.agent import Agent
from starter.components import rerank as rerank_module

_CATALOG = Path("data/catalog.jsonl") if Path("data/catalog.jsonl").exists() else Path("catalog.jsonl")
_DATASET = Path("data/public_set.jsonl")


def _run(
    agent: Agent,
    samples: list[dict],
    catalog_ids: set[str],
    categories: dict[str, list[str]],
    products: dict[str, dict],
    label: str,
    mode: str,
    weight: float,
    *,
    prior_only: bool = False,
) -> dict:
    rerank_module.RETRIEVAL_PRIOR_MODE = mode
    rerank_module.RETRIEVAL_WEIGHT = weight
    rerank_module.PRIOR_ONLY = prior_only
    result = evaluate(agent, samples, catalog_ids, categories, products)
    return {
        "label": label,
        "mode": mode,
        "weight": weight,
        "prior_only": prior_only,
        "hit_rate_at_10": result["hit_rate_at_10"],
        "mrr": result["mrr"],
        "mttc": result["mttc"],
        "technical_score": result["recommended_technical_score"],
        "buying_hit": result["scenario_metrics"]["buying"]["hit_rate_at_10"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Retrieval-prior ablation on the public set")
    parser.add_argument("--quick", action="store_true", help="Skip raw control and prior-only rows")
    args = parser.parse_args()

    samples = load_jsonl(_DATASET)
    catalog_ids, categories, products = catalog_index(_CATALOG)
    agent = Agent(_CATALOG)

    configs: list[tuple[str, str, float, bool]] = []
    if not args.quick:
        configs.append(("raw (control)", "raw", 1.0, False))
        configs.append(("prior_only", "pool_rank", 6.0, True))

    configs.append(("none", "none", 0.0, False))
    for mode in ("minmax", "log_minmax", "pool_rank", "rrf"):
        for weight in (3.0, 6.0, 9.0):
            configs.append((f"{mode} w={weight:g}", mode, weight, False))

    rows: list[dict] = []
    for label, mode, weight, prior_only in configs:
        print(f"Running {label}...", flush=True)
        rows.append(
            _run(
                agent,
                samples,
                catalog_ids,
                categories,
                products,
                label,
                mode,
                weight,
                prior_only=prior_only,
            )
        )

    print()
    print(f"{'label':<22} {'Hit@10':>7} {'MRR':>7} {'MTTC':>6} {'Tech':>7} {'buying':>7}")
    print("-" * 62)
    for row in rows:
        print(
            f"{row['label']:<22} "
            f"{row['hit_rate_at_10']:7.3f} "
            f"{row['mrr']:7.3f} "
            f"{row['mttc']:6.2f} "
            f"{row['technical_score']:7.3f} "
            f"{row['buying_hit']:7.3f}"
        )

    best = max(rows, key=lambda row: row["technical_score"])
    print()
    print(
        f"Best: {best['label']}  "
        f"Tech={best['technical_score']:.3f}  "
        f"Hit@10={best['hit_rate_at_10']:.3f}  "
        f"buying={best['buying_hit']:.3f}"
    )


if __name__ == "__main__":
    main()
