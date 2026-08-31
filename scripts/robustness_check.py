"""Does our score survive a customer who phrases things differently?

Every constant in ``starter/components`` was chosen by watching the public-set
number. The public set is not neutral data: ``materialize_hidden_fields``
(local_evaluator.py:204) mines each intent card out of the *target product's own
row*, so the simulated customer quotes the answer back at us verbatim. The
private split ships authored cards and takes the early-return branch instead, and
``competition_specification.md:40`` reserves the right to add paraphrasing.

This harness measures that exposure with two independent perturbations:

``--paraphrase``     rewrites the six customer templates (Category A: coupling to
                     frozen harness phrasing, shared by both splits)
``--authored-card``  rewrites the mined constraints into prose -- drops the
                     ``key: value`` shape and the mid-word 180-char truncation
                     (Category B: coupling to how the public labels were made)

Both preserve content words, changing only surface form. So a drop here is a
*lower bound* on the real risk: a human author would also pick different words.

Nothing in ``evaluator/`` is modified -- the harness patches module attributes
that ``evaluate`` looks up at call time.

    python3 -m scripts.robustness_check --catalog catalog.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
import re
import zlib
from contextlib import contextmanager
from pathlib import Path

from evaluator import local_evaluator as ev
from starter.agent import Agent

_DATASET = Path("data/public_set.jsonl")


def _pick(options: list[str], key: str) -> str:
    """Deterministic choice, stable across runs (unlike ``hash`` on str)."""
    return options[zlib.crc32(key.encode()) % len(options)]


# --------------------------------------------------------------- paraphrasing

# (pattern, replacements). Several variants deliberately drop the ":" lead-in,
# which is what snippets.py:66 splits on, and the ";" join that SNIPPET_SPLIT_RE
# keys off.
_REWRITES: list[tuple[str, list[str]]] = [
    (r"^I'm looking for ", ["I need ", "I'm shopping for ", "Hi, I want to find "]),
    (r"\. A key requirement is: ", [" -- it has to be ", ". Requirement: ", " and it must be "]),
    (r", but I'm still exploring\.", [" and I'm just browsing for now.", " -- not sure exactly what yet."]),
    (r"^For that, what matters is: ", ["What matters there is ", "Mainly ", "For that: "]),
    (r"; please use your judgment\.", [" -- either is fine.", ", whatever you think is best."]),
    (r"^I don't have a preference for ", ["I'm not fussy about ", "No strong feelings on "]),
    (r"^I don't have an additional preference for ", ["Nothing else to add on ", "That's all I have on "]),
    (r"^Those options are not quite right yet\.", ["Those aren't what I'm after."]),
    (
        r"^Actually, ignore my earlier preference\. What I need is: ",
        ["Scratch that -- what I actually need is ", "Change of plan. I want "],
    ),
]


def paraphrase(text: str, key: str) -> str:
    for pattern, options in _REWRITES:
        if re.search(pattern, text):
            text = re.sub(pattern, _pick(options, key + pattern), text, count=1)
    # The "; " join between two disclosed constraints.
    if "; " in text:
        text = text.replace("; ", _pick([" and ", ", plus "], key), 1)
    return text


# ------------------------------------------------------------- authored cards

_KEY_VALUE_RE = re.compile(r"^([a-z][a-z0-9 /&'-]{2,30}):\s*(.+)$", re.IGNORECASE)


def authored_constraint(value: str, key: str) -> str:
    """Reword a mined constraint the way a human writing the card would.

    Content words are preserved; only the shape changes -- the ``key: value``
    rendering from ``_flatten_values`` becomes prose, and a mid-word truncation
    is pulled back to a word boundary.
    """
    value = value.strip()
    match = _KEY_VALUE_RE.match(value)
    if match:
        field, payload = match.group(1).strip().lower(), match.group(2).strip()
        template = _pick(["the {f} is {v}", "{v} for the {f}", "{f} needs to be {v}"], key + field)
        value = template.format(f=field, v=payload)
    # intent_card truncates at 180 chars and can cut mid-word; an authored card
    # would not, so drop the partial trailing token.
    if len(value) >= 175 and " " in value:
        value = value.rsplit(" ", 1)[0]
    return value


def authored_card(card: dict, key: str) -> dict:
    return {
        "target_category": card.get("target_category", ""),
        "hard_constraints": [authored_constraint(v, key) for v in card.get("hard_constraints", [])],
        "soft_preferences": [authored_constraint(v, key) for v in card.get("soft_preferences", [])],
    }


# ------------------------------------------------------------------- patching


@contextmanager
def perturbed(*, do_paraphrase: bool, do_authored: bool):
    """Patch the evaluator's module-level hooks; restore on exit."""
    original = (ev.initial_message, ev.customer_reply, ev.materialize_hidden_fields)
    orig_initial, orig_reply, orig_materialize = original

    def initial_message(sample, category, disclosed):
        text = orig_initial(sample, category, disclosed)
        return paraphrase(text, str(sample.get("sample_id", ""))) if do_paraphrase else text

    def customer_reply(sample, ask_attribute, disclosed, boundary_used):
        text, used = orig_reply(sample, ask_attribute, disclosed, boundary_used)
        if do_paraphrase:
            text = paraphrase(text, f"{sample.get('sample_id', '')}:{len(disclosed)}")
        return text, used

    def materialize_hidden_fields(sample, products):
        card, behavior = orig_materialize(sample, products)
        if not do_authored:
            return card, behavior
        key = str(sample.get("sample_id", ""))
        card = authored_card(card, key)
        # behavior_for read the *mined* card; rebuild it against the authored one
        # so the override quotes the reworded text. Same seed source as the
        # evaluator (local_evaluator.py:210), so the override *turn* is unchanged
        # and the comparison isolates phrasing.
        seed = f"{key}\0{sample.get('scenario_type', '')}"
        behavior = ev.behavior_for(str(sample["scenario_type"]), card, random.Random(seed))
        if do_paraphrase and behavior.get("override"):
            behavior["override"]["message"] = paraphrase(behavior["override"]["message"], key)
        return card, behavior

    ev.initial_message = initial_message
    ev.customer_reply = customer_reply
    ev.materialize_hidden_fields = materialize_hidden_fields
    try:
        yield
    finally:
        ev.initial_message, ev.customer_reply, ev.materialize_hidden_fields = original


# --------------------------------------------------------------------- runner


def _row(label: str, result: dict, baseline: float | None) -> str:
    score = result["recommended_technical_score"]
    delta = "" if baseline is None else f"  {score - baseline:+.3f}"
    return (
        f"{label:<24} {score:.3f}{delta:<9} "
        f"hit {result['hit_rate_at_10']:.3f}  mrr {result['mrr']:.3f}  mttc {result['mttc']:.2f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--catalog", default="data/catalog.jsonl")
    parser.add_argument("--dataset", default=str(_DATASET))
    parser.add_argument("--limit", type=int, default=0, help="evaluate only the first N sessions")
    parser.add_argument(
        "--ablate",
        action="store_true",
        help="score each paraphrase rewrite on its own, to find which one costs the most",
    )
    args = parser.parse_args()

    catalog_path = Path(args.catalog)
    if not catalog_path.exists():
        raise SystemExit(f"catalog not found at {catalog_path} -- see data/README.md")

    catalog_ids, categories, products = ev.catalog_index(catalog_path)
    with Path(args.dataset).open(encoding="utf-8") as handle:
        samples = [json.loads(line) for line in handle if line.strip()]
    if args.limit:
        samples = samples[: args.limit]

    agent = Agent(str(catalog_path))

    if args.ablate:
        print(f"\n{len(samples)} sessions -- one rewrite at a time\n")
        with perturbed(do_paraphrase=False, do_authored=False):
            base = ev.evaluate(agent, samples, catalog_ids, categories, products)
        print(_row("baseline", base, None))
        every = list(_REWRITES)
        for pattern, options in every:
            _REWRITES[:] = [(pattern, options)]
            with perturbed(do_paraphrase=True, do_authored=False):
                result = ev.evaluate(agent, samples, catalog_ids, categories, products)
            print(_row(pattern[:22], result, base["recommended_technical_score"]))
        _REWRITES[:] = every
        print()
        return

    conditions = [
        ("baseline", False, False),
        ("paraphrase", True, False),
        ("authored-card", False, True),
        ("both", True, True),
    ]

    print(f"\n{len(samples)} sessions, catalog {catalog_path}\n")
    baseline: float | None = None
    for label, do_paraphrase, do_authored in conditions:
        with perturbed(do_paraphrase=do_paraphrase, do_authored=do_authored):
            result = ev.evaluate(agent, samples, catalog_ids, categories, products)
        print(_row(label, result, baseline))
        if baseline is None:
            baseline = result["recommended_technical_score"]
    print()


if __name__ == "__main__":
    main()
