"""Ablation harness for retrieval-prior and phrase-weight modes in the reranker.

Builds one Agent (one catalog index), then re-runs the public-set evaluator
while mutating module-level knobs in ``starter.components.rerank`` and/or
``starter.components.search_plan``.

    python3 -m scripts.score_ablation
    python3 -m scripts.score_ablation --quick
    python3 -m scripts.score_ablation --phrases
"""

from __future__ import annotations

import argparse
from pathlib import Path

from evaluator.local_evaluator import catalog_index, evaluate, load_jsonl
from starter.agent import Agent
from starter.components import rerank as rerank_module
from starter.components import search_plan as search_plan_module

_CATALOG = Path("data/catalog.jsonl") if Path("data/catalog.jsonl").exists() else Path("catalog.jsonl")
_DATASET = Path("data/public_set.jsonl")


def _run(
    agent: Agent,
    samples: list[dict],
    catalog_ids: set[str],
    categories: dict[str, list[str]],
    products: dict[str, dict],
    label: str,
    *,
    mode: str = "minmax",
    retrieval_weight: float = 9.0,
    phrase_weight: float = 1.0,
    stripped_phrases: bool = True,
    prior_only: bool = False,
) -> dict:
    rerank_module.RETRIEVAL_PRIOR_MODE = mode
    rerank_module.RETRIEVAL_WEIGHT = retrieval_weight
    rerank_module.PHRASE_WEIGHT = phrase_weight
    rerank_module.PRIOR_ONLY = prior_only
    search_plan_module.STRIPPED_EXACT_PHRASES = stripped_phrases
    result = evaluate(agent, samples, catalog_ids, categories, products)
    return {
        "label": label,
        "mode": mode,
        "retrieval_weight": retrieval_weight,
        "phrase_weight": phrase_weight,
        "stripped_phrases": stripped_phrases,
        "prior_only": prior_only,
        "hit_rate_at_10": result["hit_rate_at_10"],
        "mrr": result["mrr"],
        "mttc": result["mttc"],
        "technical_score": result["recommended_technical_score"],
        "buying_hit": result["scenario_metrics"]["buying"]["hit_rate_at_10"],
    }


def _print_table(rows: list[dict]) -> None:
    print()
    print(f"{'label':<28} {'Hit@10':>7} {'MRR':>7} {'MTTC':>6} {'Tech':>7} {'buying':>7}")
    print("-" * 68)
    for row in rows:
        print(
            f"{row['label']:<28} "
            f"{row['hit_rate_at_10']:7.3f} "
            f"{row['mrr']:7.3f} "
            f"{row['mttc']:6.2f} "
            f"{row['technical_score']:7.3f} "
            f"{row['buying_hit']:7.3f}"
        )


def _best_row(rows: list[dict]) -> dict:
    return max(rows, key=lambda row: (row["technical_score"], row["mrr"]))


def run_prior_ablation(agent: Agent, samples, catalog_ids, categories, products, *, quick: bool) -> None:
    configs: list[tuple[str, str, float, bool]] = []
    if not quick:
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
                mode=mode,
                retrieval_weight=weight,
                prior_only=prior_only,
            )
        )

    _print_table(rows)
    best = _best_row(rows)
    print()
    print(
        f"Best: {best['label']}  "
        f"Tech={best['technical_score']:.3f}  "
        f"MRR={best['mrr']:.3f}  "
        f"Hit@10={best['hit_rate_at_10']:.3f}  "
        f"buying={best['buying_hit']:.3f}"
    )


def run_phrase_ablation(agent: Agent, samples, catalog_ids, categories, products) -> None:
    configs: list[tuple[str, bool, float, float]] = [
        ("dead phrases (legacy)", False, 9.0, 1.0),
        ("stripped pw=1.0 rw=9", True, 9.0, 1.0),
        ("stripped pw=1.5 rw=9", True, 9.0, 1.5),
        ("stripped pw=2.0 rw=9", True, 9.0, 2.0),
        ("stripped pw=1.0 rw=6", True, 6.0, 1.0),
        ("stripped pw=1.5 rw=6", True, 6.0, 1.5),
    ]

    rows: list[dict] = []
    for label, stripped, retrieval_weight, phrase_weight in configs:
        print(f"Running {label}...", flush=True)
        rows.append(
            _run(
                agent,
                samples,
                catalog_ids,
                categories,
                products,
                label,
                stripped_phrases=stripped,
                retrieval_weight=retrieval_weight,
                phrase_weight=phrase_weight,
            )
        )

    _print_table(rows)
    best = _best_row(rows)
    print()
    print(
        f"Best: {best['label']}  "
        f"Tech={best['technical_score']:.3f}  "
        f"MRR={best['mrr']:.3f}  "
        f"Hit@10={best['hit_rate_at_10']:.3f}  "
        f"buying={best['buying_hit']:.3f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Rerank ablation on the public set")
    parser.add_argument("--quick", action="store_true", help="Skip raw control and prior-only rows")
    parser.add_argument("--phrases", action="store_true", help="Sweep stripped phrase weights")
    args = parser.parse_args()

    samples = load_jsonl(_DATASET)
    catalog_ids, categories, products = catalog_index(_CATALOG)
    agent = Agent(_CATALOG)

    if args.phrases:
        run_phrase_ablation(agent, samples, catalog_ids, categories, products)
    else:
        run_prior_ablation(agent, samples, catalog_ids, categories, products, quick=args.quick)


if __name__ == "__main__":
    main()
