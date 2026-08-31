"""Grid-search cross-encoder ``top_n`` and ``weight`` on the public set.

Loads the catalog index and cross-encoder model once, then re-runs evaluation
for each parameter combo. Saves results after every run so you can stop and
resume.

Quick tune (~10 configs on 50 sessions, ~15–30 min with cross-encoder on CPU):

    python3 -m scripts.cross_encoder_sweep --mode quick

Full public set (35 configs × 200 sessions — may take many hours on CPU):

    python3 -m scripts.cross_encoder_sweep --mode full

Resume after interrupt:

    python3 -m scripts.cross_encoder_sweep --mode quick --resume

Output written to ``cross_encoder_sweep_results.json`` by default.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from evaluator.local_evaluator import catalog_index, evaluate, load_jsonl
from starter.agent import Agent

_CATALOG = Path("data/catalog.jsonl")
_DATASET = Path("data/public_set.jsonl")
_DEFAULT_OUTPUT = Path("cross_encoder_sweep_results.json")

_PRESETS: dict[str, dict] = {
    "quick": {
        "sample_limit": 50,
        "top_ns": (10, 15, 20),
        "weights": (1.0, 2.0, 3.0),
    },
    "full": {
        "sample_limit": 0,
        "top_ns": (8, 12, 15, 20, 25),
        "weights": (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0),
    },
}


def _config_key(top_n: int, weight: float) -> str:
    return f"top_n={top_n},weight={weight}"


def run_once(agent: Agent, samples: list[dict], catalog_ids, categories, products) -> dict:
    result = evaluate(agent, samples, catalog_ids, categories, products)
    return {
        "technical_score": result["recommended_technical_score"],
        "hit_rate_at_10": result["hit_rate_at_10"],
        "mrr": result["mrr"],
        "mttc": result["mttc"],
        "efficiency": result["efficiency"],
    }


def _load_output(path: Path) -> dict:
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def _save_output(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _select_samples(samples: list[dict], limit: int) -> list[dict]:
    if limit <= 0 or limit >= len(samples):
        return samples
    step = max(1, len(samples) // limit)
    picked = samples[::step][:limit]
    return picked if picked else samples[:limit]


def _print_row(label: str, metrics: dict, elapsed: float) -> None:
    print(
        f"{label}  "
        f"score={metrics['technical_score']:.6f}  "
        f"hit={metrics['hit_rate_at_10']:.3f}  "
        f"mrr={metrics['mrr']:.4f}  "
        f"mttc={metrics['mttc']:.2f}  "
        f"({elapsed / 60:.1f} min)",
        flush=True,
    )


def _rank_rows(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda row: (-row["technical_score"], -row["mrr"], row["mttc"]))


def main() -> None:
    parser = argparse.ArgumentParser(description="Sweep cross-encoder top_n and weight")
    parser.add_argument(
        "--mode",
        choices=("quick", "full"),
        default="quick",
        help="quick = 50 sessions, 9 configs; full = 200 sessions, 35 configs (default: quick)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_DEFAULT_OUTPUT,
        help=f"JSON results path (default: {_DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip configs already present in the output file",
    )
    parser.add_argument(
        "--skip-baseline",
        action="store_true",
        help="Do not re-run the rule-only baseline",
    )
    args = parser.parse_args()

    if not _CATALOG.is_file():
        print(f"Missing catalog: {_CATALOG}", file=sys.stderr)
        print("Run: cd data && unzip -o catalog.jsonl.zip", file=sys.stderr)
        sys.exit(1)

    preset = _PRESETS[args.mode]
    top_ns: tuple[int, ...] = preset["top_ns"]
    weights: tuple[float, ...] = preset["weights"]
    total_configs = len(top_ns) * len(weights)

    samples = _select_samples(load_jsonl(_DATASET), preset["sample_limit"])
    catalog_ids, categories, products = catalog_index(_CATALOG)

    print(f"Mode: {args.mode}  sessions={len(samples)}  configs={total_configs}", flush=True)
    print(f"Output: {args.output}", flush=True)
    print("Loading agent (FTS index + cross-encoder model)...", flush=True)
    t0 = time.perf_counter()
    agent = Agent(_CATALOG)
    print(f"Agent ready in {(time.perf_counter() - t0) / 60:.1f} min\n", flush=True)

    payload = _load_output(args.output) if args.resume else {}
    payload.setdefault("mode", args.mode)
    payload.setdefault("sample_count", len(samples))
    payload.setdefault("baseline", None)
    payload.setdefault("runs", [])

    completed = {_config_key(row["top_n"], row["weight"]) for row in payload.get("runs", [])}

    if not args.skip_baseline and payload.get("baseline") is None:
        os.environ["TECHJAM_CROSS_ENCODER_DISABLE"] = "1"
        print("[baseline] rule-only (cross-encoder disabled)", flush=True)
        start = time.perf_counter()
        payload["baseline"] = run_once(agent, samples, catalog_ids, categories, products)
        _print_row("[baseline]", payload["baseline"], time.perf_counter() - start)
        _save_output(args.output, payload)
        print(flush=True)

    os.environ.pop("TECHJAM_CROSS_ENCODER_DISABLE", None)
    run_index = 0
    for top_n in top_ns:
        for weight in weights:
            run_index += 1
            key = _config_key(top_n, weight)
            if args.resume and key in completed:
                print(f"[{run_index}/{total_configs}] skip {key} (already done)", flush=True)
                continue

            os.environ["TECHJAM_CROSS_ENCODER_TOP_N"] = str(top_n)
            os.environ["TECHJAM_CROSS_ENCODER_WEIGHT"] = str(weight)
            print(f"[{run_index}/{total_configs}] {key}", flush=True)
            start = time.perf_counter()
            metrics = run_once(agent, samples, catalog_ids, categories, products)
            elapsed = time.perf_counter() - start
            row = {"top_n": top_n, "weight": weight, "elapsed_sec": round(elapsed, 1), **metrics}
            payload["runs"] = [existing for existing in payload["runs"] if _config_key(existing["top_n"], existing["weight"]) != key]
            payload["runs"].append(row)
            payload["runs"] = _rank_rows(payload["runs"])
            if payload["runs"]:
                best = payload["runs"][0]
                payload["best"] = {
                    "top_n": best["top_n"],
                    "weight": best["weight"],
                    "technical_score": best["technical_score"],
                }
            _save_output(args.output, payload)
            _print_row("  ->", metrics, elapsed)

    print("\n=== BASELINE (rule-only) ===", flush=True)
    print(json.dumps(payload.get("baseline"), indent=2), flush=True)

    print("\n=== TOP 5 CONFIGS ===", flush=True)
    for row in payload.get("runs", [])[:5]:
        print(row, flush=True)

    if payload.get("runs"):
        best = payload["runs"][0]
        baseline_score = (payload.get("baseline") or {}).get("technical_score")
        delta = ""
        if baseline_score is not None:
            delta = f"  (baseline {baseline_score:.6f}, delta {best['technical_score'] - baseline_score:+.6f})"
        print("\n=== RECOMMENDED ===", flush=True)
        print(
            f"export TECHJAM_CROSS_ENCODER_TOP_N={best['top_n']}\n"
            f"export TECHJAM_CROSS_ENCODER_WEIGHT={best['weight']}\n"
            f"# score={best['technical_score']:.6f}{delta}",
            flush=True,
        )
        print(f"\nFull results: {args.output}", flush=True)


if __name__ == "__main__":
    main()
