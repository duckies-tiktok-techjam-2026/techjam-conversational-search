# Interactive pipeline presentation

A zero-dependency, offline HTML presentation of the TechJam conversational search agent:
an interactive flowchart you can click into, plus four supporting views.

## Open it

```bash
open presentation/index.html          # macOS
# or just double-click the file — no server, no build step, no network
```

## What is in it

**System view** — a zoomable flowchart with three levels of depth:

| Level | Graph | What it shows |
| ----- | ----- | ------------- |
| 0 | System overview | The frozen evaluator, the simulated customer, our agent, the scorer, and the 10-turn loop |
| 1 | Agent pipeline | `__init__` plus the nine steps of every `respond()` call, and the data each one produces |
| 2 | `parse_message` · `SessionStore.update` · `build_search_plan` + snippets · `get_candidates` · `rerank` · cross-encoder · `choose_question_attribute` | The internals of each stage: constants, source excerpts, and why it is built that way |

Interaction:

- **Click a box** — the camera zooms to it and the right panel fills with the source file and
  line range, the code, the constants that matter, and the design rationale.
- **Boxes badged `⤢ drill in`** — open a sub-flowchart of that component's internals.
  Double-click drills in directly.
- **Drag** to pan, **scroll** to zoom, **double-click the background** or press `F` to fit.
- **`Back` / `Esc`** — zoom out one level. Breadcrumbs jump to any ancestor.
- **`▶ Play a turn`** — steps through one real buying session, lighting up each pipeline stage
  with the data flowing through it. `←` / `→` navigate steps.

**Other views:** Scoring model (every weight in `score_product`, as bars) · Scenarios (the four
scenario types with transcripts and the code that handles each) · Results (metrics, per-scenario
breakdown, the change-by-change progression, open items) · Team.

## Deep links

Any state is addressable, so you can link a reviewer straight to one diagram:

```
presentation/index.html#v=system&g=rerank            # the scoring-model flowchart
presentation/index.html#v=system&g=retrieval&n=pathC # zoomed on the conjunctive-core path
presentation/index.html#v=system&t=5                 # trace, step 6
presentation/index.html#v=results                    # the results view
```

## Files

| File | Contents |
| ---- | -------- |
| `index.html` | Shell markup |
| `data.js` | All content: 9 graphs, 97 nodes, 101 edges, node details, metrics, transcripts |
| `app.js` | SVG renderer, camera/zoom, drill-down navigation, detail panel, doc views |
| `styles.css` | Dark theme |
| `index-simple.html` | Earlier, static single-page version, kept for reference |

## Keeping it accurate

Numbers come from the committed `results.json` (cross-encoder pipeline enabled: HitRate@10
0.965 · MRR 0.606 · MTTC 2.995 · TechnicalScore 0.824) and from
`cross_encoder_sweep_results.json`. Code excerpts and line ranges are quoted from
`starter/`, `evaluator/` and `scripts/`. After a pipeline change, re-run the evaluator and
update `RESULTS` and `KPIS` in `data.js`.
