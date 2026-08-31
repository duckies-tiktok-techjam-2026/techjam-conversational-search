# Pipeline presentation

A zero-dependency, offline HTML walkthrough of the TechJam conversational search agent:
the whole pipeline on one screen, with every stage clickable.

## Open it

```bash
open presentation/index-simple.html   # macOS
# or just double-click the file — no server, no build step, no network
```

## What is in it

One canvas with five stages of every `respond()` call — customer message → parse the turn →
retrieve candidates → rank & return → clarification question — wired in order with the data
that flows between them.

Interaction:

- **Click a stage** — the canvas zooms to it and a panel opens with what the stage does, the
  source file(s) it maps to, and the design rationale.
- **Grouped stages** (parse, rank) expand into their sub-steps when focused.
- **`← Back` / `Esc`** — zoom back out.

The header carries the reported metrics: TechnicalScore 0.824 · Hit@10 0.965 · MRR 0.606 ·
MTTC 3.0.

## Files

| File | Contents |
| ---- | -------- |
| `index-simple.html` | The whole presentation — markup, styles and renderer in one file |
| `baseline.html` | Standalone slide: shortcomings of the provided baseline agent |
| `../SCRIPT.md` | Spoken walkthrough script, slide by slide (repo root) |

## Keeping it accurate

Numbers come from the committed `results.json` (cross-encoder pipeline enabled: HitRate@10
0.965 · MRR 0.606 · MTTC 2.995 · TechnicalScore 0.824). After a pipeline change, re-run the
evaluator and update the metrics in the header and the stage copy.
