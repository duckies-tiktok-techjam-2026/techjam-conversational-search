/* =============================================================================
   data.js — all presentation content for the TechJam conversational search agent.
   Every number, constant and code excerpt here is taken from the repository:
     starter/agent.py, starter/components/*.py, evaluator/local_evaluator.py,
     results.json, cross_encoder_sweep_results.json, CLAUDE.md, README.md
   ========================================================================== */

const KPIS = [
  { label: "TechnicalScore", value: "0.824", tone: "good" },
  { label: "HitRate@10", value: "0.965", tone: "good" },
  { label: "MRR", value: "0.606", tone: "warn" },
  { label: "MTTC", value: "3.00", tone: "good" },
  { label: "LLM tokens", value: "0", tone: "neutral" },
];

/* ------------------------------------------------------------------ helpers */
const F = (file, lines) => ({ file, lines });

/* =============================================================================
   GRAPHS
   ========================================================================== */

const GRAPHS = {

  /* ======================= LEVEL 0 — SYSTEM ============================== */
  system: {
    title: "System overview",
    subtitle: "How the frozen evaluator, the simulated customer and our agent interact for up to 10 turns",
    w: 1400, h: 900,
    frames: [
      { x: 20, y: 12, w: 660, h: 150, label: "Frozen inputs — must not be modified" },
      { x: 20, y: 345, w: 1340, h: 515, label: "One session · up to 10 turns" },
    ],
    nodes: [
      {
        id: "dataset", x: 40, y: 42, w: 290, h: 96, kind: "data",
        label: "public_set.jsonl", sub: "200 sessions · sample_id, scenario_type, user_profile, ground_truth",
        detail: {
          ...F("data/public_set.jsonl", null),
          summary: "The public split: 200 evaluation sessions. Each row carries the scenario type, an anonymized aggregate user profile, and the hidden target product id.",
          bullets: [
            "Scenario mix: 80 buying · 80 browsing · 30 intent_override · 10 boundary (40/40/15/5%).",
            "user_profile is aggregate only — purchase_frequency, average_prior_rating, rating_style, preference_tags, summary. No item history.",
            "ground_truth.parent_asin is the single product that must appear in our Top 10.",
            "No intent card and no simulator internals are shipped — the evaluator derives them (see the next box).",
          ],
          constants: [["sessions", "200"], ["turn budget", "10"], ["top_k", "10"]],
          why: "The private split has the same shape and scenario mix but 800 sessions, so anything tuned to a specific public sample will not transfer.",
        },
      },
      {
        id: "catalog", x: 370, y: 42, w: 290, h: 96, kind: "data",
        label: "catalog.jsonl", sub: "50,000 products · ~60 MB · Amazon Reviews 2023",
        detail: {
          ...F("data/catalog.jsonl", null),
          summary: "The frozen product corpus. Every recommendation must be a parent_asin from this file; anything else is silently dropped by the scorer.",
          bullets: [
            "Agent-visible fields: parent_asin, title, features[], description[], price (nullable), categories[], details{}, average_rating, rating_number, store.",
            "Only parent_asin is scored — the rest is signal.",
            "Downloaded from the GitHub Release, not committed. data/catalog.jsonl is gitignored.",
            "Read twice at startup: once into a plain dict (agent.py:_load_products) and once into the FTS5 index (retrieval.py).",
          ],
          constants: [["rows", "50,000"], ["size", "~60 MB"], ["scored field", "parent_asin"]],
        },
      },
      {
        id: "docs", x: 1000, y: 42, w: 290, h: 96, kind: "data",
        label: "Frozen contract", sub: "agent_api_contract.json · evaluation_config.json",
        detail: {
          ...F("docs/", null),
          summary: "The authoritative interface. The agent is a plain Python class with three methods; malformed output is not an error, it is a miss.",
          bullets: [
            "__init__(catalog_path) — build indexes here, it is outside the per-turn budget.",
            "reset(session_id, user_profile) — once per session, before any respond().",
            "respond(session_id, user_message, turn, top_k) -> {message, ask_attribute, recommendations, usage?}.",
            "agent_api_contract.json sets additionalProperties: false — extra keys are a schema violation.",
            "Raised exceptions and malformed dicts are swallowed by the harness and scored as a miss for that turn (local_evaluator.py:239-244).",
          ],
          code: {
            lang: "python",
            text:
`# evaluator/local_evaluator.py:239
try:
    response = agent.respond(session_id, user_message, turn, TOP_K)
except Exception:
    response = {"message": "", "ask_attribute": None, "recommendations": []}`,
          },
          why: "Because failures are silent, the agent is written to always return a well-formed dict rather than to assert on its inputs.",
        },
      },
      {
        id: "hidden", x: 40, y: 192, w: 290, h: 120, kind: "eval",
        label: "materialize_hidden_fields()", sub: "derives intent_card + behavior from the target row",
        detail: {
          ...F("evaluator/local_evaluator.py", "52–88, 204–213"),
          summary: "There are no real conversation logs. The evaluator reverse-engineers what the customer 'wants' directly out of the target product, deterministically.",
          bullets: [
            "intent_card() flattens the target's features[] and details{} into 'key: value' strings, prepends a regex-matched material and color, appends 'budget around $price'.",
            "Each string is cleaned and truncated to 180 characters — which is why disclosed clues are sometimes cut mid-word.",
            "hard_constraints = first 2 cleaned strings; soft_preferences = next 2.",
            "behavior_for() adds the override plan for intent_override sessions: turn 3 or 4, chosen by a Random seeded on sample_id.",
          ],
          code: {
            lang: "python",
            text:
`# evaluator/local_evaluator.py:52
def intent_card(product: dict, limit: int = 180) -> dict:
    title = _clean_constraint(str(product.get("title") or "product"), limit)
    candidates = [*_flatten_values(product.get("features")),
                  *_flatten_values(product.get("details"))]
    if material: candidates.insert(0, material.group(1).lower())
    if color:    candidates.insert(1, f"color: {color.group(1).lower()}")
    if product.get("price") not in (None, ""):
        candidates.append(f"budget around \${product['price']}")
    return {"target_category": title,
            "hard_constraints": cleaned[:2],
            "soft_preferences": cleaned[2:4] or cleaned[:1]}`,
          },
          constants: [["truncation limit", "180 chars"], ["hard constraints", "2"], ["soft preferences", "2"], ["override turn", "3 or 4 (seeded)"]],
          why: "THIS IS THE CENTRAL EXPLOIT OF OUR DESIGN. Because the customer quotes the target product's own catalog text back at us, a disclosed clue is usually a verbatim substring of the target row and of almost nothing else. Our whole pipeline is built to preserve that raw text instead of paraphrasing it into structured fields.",
        },
      },
      {
        id: "sim", x: 40, y: 392, w: 290, h: 130, kind: "eval",
        label: "Simulated customer", sub: "initial_message() · customer_reply() · classify_constraint()",
        drill: null,
        detail: {
          ...F("evaluator/local_evaluator.py", "137–186"),
          summary: "A deterministic turn generator, not an LLM. It reveals at most one to two not-yet-disclosed constraints per turn, and only ones that match the attribute we asked for.",
          bullets: [
            "Turn 1 opener depends on the scenario: buying leaks a hard constraint immediately; browsing says 'but I'm still exploring'; intent_override states the preference it will later retract.",
            "Every later turn: classify_constraint(value) buckets each undisclosed clue into budget/material/color/size/style/use_case/feature, and only clues matching our ask_attribute are released.",
            "ask_attribute: None yields 'Those options are not quite right yet. Ask me about one specific attribute.' — a wasted turn.",
            "Asking an exhausted attribute yields 'I don't have an additional preference for X.' — also a wasted turn.",
            "ask_attribute 'other' matches ANY remaining clue, which makes it the highest-yield ask once the specific buckets are dry.",
          ],
          code: {
            lang: "python",
            text:
`# evaluator/local_evaluator.py:174
matches = [
    value for value in constraints
    if value not in disclosed
    and (attribute == "other" or classify_constraint(value) == attribute)
][:2]
if not matches:
    return f"I don't have an additional preference for {attribute}.", boundary_used
disclosed.update(matches)
return "For that, what matters is: " + "; ".join(matches) + ".", boundary_used`,
          },
          why: "Question targeting is not cosmetic — it is the only lever that controls the information we receive. This is why questions.py directly moves MTTC.",
        },
      },
      {
        id: "agent", x: 470, y: 362, w: 400, h: 190, kind: "agent", drill: "pipeline",
        label: "Our Agent", sub: "starter/agent.py · 5-stage retrieval + ranking pipeline",
        badge: "drill",
        detail: {
          ...F("starter/agent.py", "1–75"),
          summary: "The only file we own. 74 lines of wiring: parse the turn, fold it into session state, build a search plan, retrieve a candidate pool, rank it, answer with Top 10 plus one clarification question.",
          bullets: [
            "Standard library only for the retrieval and rule-ranking path — SQLite FTS5 does the heavy lifting.",
            "One optional dependency: sentence-transformers, for the cross-encoder second stage (on by default).",
            "Zero LLM calls, so reported token usage is exactly 0.",
            "State lives in SessionStore keyed by session_id, so sessions never leak into each other.",
          ],
          code: {
            lang: "python",
            text:
`# starter/agent.py:47
def respond(self, session_id, user_message, turn, top_k) -> dict:
    state  = self.session_store.get(session_id)
    parsed = parse_message(user_message)
    self.session_store.update(state, user_message, parsed)
    state.last_search_plan = build_search_plan(state)
    ranked = rerank(
        self._retrieve_candidates(state),
        state, state.last_search_plan, self.products,
        cross_encoder=self.cross_encoder_reranker,
    )
    recommendations = [{"parent_asin": pa} for pa in ranked[:top_k]]
    state.last_recommendations = [i["parent_asin"] for i in recommendations]
    ask_attribute = choose_question_attribute(state, turn)
    self.session_store.mark_question(state, ask_attribute)
    return {"message": question_text(ask_attribute),
            "ask_attribute": ask_attribute,
            "recommendations": recommendations,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0}}`,
          },
          why: "Click this box (or the drill badge) to open the pipeline.",
        },
      },
      {
        id: "norm", x: 1000, y: 392, w: 290, h: 130, kind: "eval",
        label: "normalize_recommendations()", sub: "first 10 unique ids that exist in the catalog",
        detail: {
          ...F("evaluator/local_evaluator.py", "95–109"),
          summary: "A strict filter between us and the scoreboard. Unknown ids, duplicates and non-dict entries are dropped without warning, then the list is cut to 10.",
          bullets: [
            "A hit requires exact parent_asin equality — no fuzzy matching, no partial credit.",
            "Duplicates are removed, so padding the list with repeats wastes slots.",
            "Ids not in the frozen catalog are dropped, so a hallucinated id costs a slot silently.",
            "For intent_override sessions the override_applied gate blocks any hit before the override message is delivered on turn 3 or 4.",
          ],
          code: {
            lang: "python",
            text:
`# evaluator/local_evaluator.py:252
if override_applied and target in ranked:
    best_rank = ranked.index(target) + 1
    hit_turn = turn
    break`,
          },
          why: "The override gate is why intent_override sessions can never score MTTC below 3 — an early correct guess simply does not count.",
        },
      },
      {
        id: "score", x: 470, y: 620, w: 400, h: 110, kind: "score",
        label: "Scorer", sub: "hit · reciprocal_rank · first_hit_turn → per-scenario metrics",
        detail: {
          ...F("evaluator/local_evaluator.py", "188–201, 278–295"),
          summary: "Per session the harness records whether the target was ever in the Top 10, at what rank, and on which turn. Those three numbers become the three metrics.",
          bullets: [
            "hit — target appeared in the Top 10 at any turn (session stops on the first hit).",
            "reciprocal_rank — 1 / rank of the target at the hitting turn; 0 on a miss.",
            "first_hit_turn — the turn number; a miss is counted as turn 11, which is what makes MTTC punishing.",
            "Metrics are also broken out per scenario_type.",
          ],
          code: {
            lang: "python",
            text:
`# evaluator/local_evaluator.py:193
mttc = statistics.fmean(
    item["first_hit_turn"] if item["first_hit_turn"] is not None else MAX_TURNS + 1
    for item in sessions
)`,
          },
        },
      },
      {
        id: "ts", x: 470, y: 780, w: 400, h: 80, kind: "out",
        label: "TechnicalScore = 0.824", sub: "0.50·Hit@10 + 0.30·MRR + 0.20·Efficiency",
        detail: {
          ...F("docs/evaluation_config.json", null),
          summary: "The single reported number. Hit rate dominates, but with Hit@10 at 0.965 the remaining headroom is almost entirely in MRR.",
          bullets: [
            "Efficiency = clip((11 − MTTC) / 10, 0, 1); a miss enters MTTC as turn 11.",
            "Latency and token usage are feasibility signals only — they do not move the score.",
            "Current run: 0.50·0.965 + 0.30·0.6056 + 0.20·0.8005 = 0.8243.",
            "Weak-BM25 reference baseline: 0.107.",
          ],
          constants: [["Hit@10 weight", "0.50"], ["MRR weight", "0.30"], ["Efficiency weight", "0.20"], ["miss penalty", "turn 11"]],
          why: "MRR 0.606 against a 0.965 hit rate means the target is usually found but lands around rank 2–3 rather than rank 1. That gap is the reason the cross-encoder stage exists.",
        },
      },
    ],
    edges: [
      { from: "dataset", to: "hidden", fromSide: "bottom", toSide: "top", label: "ground_truth.parent_asin" },
      { from: "catalog", to: "hidden", fromSide: "bottom", toSide: "right", label: "target row" },
      { from: "hidden", to: "sim", fromSide: "bottom", toSide: "top", label: "intent_card + behavior", bus: 334 },
      { from: "sim", to: "agent", fromSide: "right", toSide: "left", label: "user_message, turn" },
      { from: "agent", to: "norm", fromSide: "right", toSide: "left", label: "recommendations[10]" },
      { from: "norm", to: "sim", fromSide: "bottom", toSide: "bottom", label: "ask_attribute → next turn (≤ 10)", kind: "loop", bus: 578, fromOffset: -0.28, toOffset: 0.28 },
      { from: "norm", to: "score", fromSide: "bottom", toSide: "right", label: "hit? rank?", fromOffset: 0.28 },
      { from: "score", to: "ts", fromSide: "bottom", toSide: "top" },
      { from: "catalog", to: "agent", fromSide: "bottom", toSide: "top", label: "catalog_path (init)", kind: "dashed", bus: 340, fromOffset: 0.3 },
    ],
  },

  /* ======================= LEVEL 1 — PIPELINE ============================ */
  pipeline: {
    title: "Agent pipeline",
    subtitle: "starter/agent.py — what happens on every single respond() call, plus the one-time index build",
    parent: "system",
    w: 1520, h: 1330,
    frames: [
      { x: 30, y: 40, w: 400, h: 480, label: "__init__ — once per run (outside the turn budget)" },
      { x: 500, y: 40, w: 500, h: 1250, label: "respond() — every turn" },
      { x: 1040, y: 300, w: 400, h: 620, label: "data produced along the way" },
    ],
    nodes: [
      {
        id: "load_products", x: 60, y: 90, w: 340, h: 96, kind: "init",
        label: "_load_products()", sub: "catalog.jsonl → dict[parent_asin] = row",
        detail: {
          ...F("starter/agent.py", "28–36"),
          summary: "First catalog pass: a plain in-memory dict so the reranker can read any product's full fields by id in O(1).",
          bullets: [
            "50,000 rows of parsed JSON held in memory — the reranker needs title/features/details/price/rating, not just the id.",
            "parent_asin is coerced to str on the way in so lookups never miss on type.",
            "This is a second, separate pass over the same file as the FTS5 index build — a known inefficiency.",
          ],
          code: {
            lang: "python",
            text:
`# starter/agent.py:28
def _load_products(self) -> None:
    with self.catalog_path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            product = json.loads(line)
            parent_asin = str(product["parent_asin"])
            product["parent_asin"] = parent_asin
            self.products[parent_asin] = product`,
          },
          why: "Retrieval only ever returns ids and a BM25 score. Ranking needs the whole row, so it is cheaper to hold the catalog than to re-query SQLite per candidate per turn.",
        },
      },
      {
        id: "build_index", x: 60, y: 226, w: 340, h: 130, kind: "init",
        label: "CandidateIndex.__init__()", sub: "in-memory FTS5 table + token document-frequency table",
        detail: {
          ...F("starter/components/retrieval.py", "54–91"),
          summary: "Second catalog pass: builds a SQLite FTS5 virtual table over six weighted text columns, and a Counter of how many documents each token appears in.",
          bullets: [
            "Table columns in BM25-weight order: parent_asin (UNINDEXED), title, categories, features, details, description, store.",
            "Tokenizer: unicode61 remove_diacritics 2.",
            "Inserted in batches of 1,000 rows.",
            "The df Counter is what later decides which words in a customer sentence are actually selective.",
          ],
          code: {
            lang: "python",
            text:
`# starter/components/retrieval.py:62
cursor.execute(
    "CREATE VIRTUAL TABLE products USING fts5("
    "parent_asin UNINDEXED, title, categories, features, details, description, store, "
    "tokenize='unicode61 remove_diacritics 2')"
)
...
for token in set(_tokens(" ".join(row[1:]))):
    self.df[token] += 1`,
          },
          constants: [["BM25 weights", "title 8.0 · categories 5.0 · features 3.0 · details 3.0 · description 1.0 · store 0.5"], ["insert batch", "1000"], ["build time", "~40 s, uncached"]],
          why: "Nothing here is trained. It is a lexical index, which is exactly the right tool when the customer is quoting catalog text verbatim.",
        },
      },
      {
        id: "warm_up", x: 60, y: 396, w: 340, h: 106, kind: "ml",
        label: "CrossEncoderReranker.warm_up()", sub: "loads cross-encoder/ms-marco-MiniLM-L-6-v2",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "110–140"),
          summary: "Loads the second-stage neural reranker once at startup so no turn pays the model-load cost.",
          bullets: [
            "Weights (~90 MB) download from Hugging Face on the very first run; afterwards they are cached locally.",
            "If sentence-transformers is missing, warm_up pip-installs from requirements.txt and retries.",
            "TECHJAM_CROSS_ENCODER_DISABLE=1 skips the whole stage — used only for rule-only baseline comparisons.",
          ],
          constants: [["model", "cross-encoder/ms-marco-MiniLM-L-6-v2"], ["weights", "~90 MB"], ["disable env", "TECHJAM_CROSS_ENCODER_DISABLE=1"]],
          why: "Final scoring may run with the network disabled, so the model must already be cached — the download is a first-run setup step, not a per-turn dependency.",
        },
      },

      {
        id: "in_msg", x: 560, y: 90, w: 380, h: 90, kind: "data",
        label: "① customer turn arrives", sub: "user_message, turn, top_k = 10",
        detail: {
          ...F("starter/agent.py", "47–56"),
          summary: "The turn's raw text — and the most valuable object in the whole pipeline, because it usually contains a literal fragment of the target product's catalog row.",
          bullets: [
            "Turn 1 is scenario-shaped; turns 2+ are answers to whatever attribute we asked about.",
            "A turn may also be a non-answer ('I don't have an additional preference for color') or the override message.",
            "top_k is always 10.",
          ],
          code: {
            lang: "text",
            text:
`turn 1  "I'm looking for Men's T-Shirts. A key requirement is: fabric type: 100% cotton."
turn 2  "For that, what matters is: 4.3 oz jersey knit; tagless collar for comfort."
turn 3  "I don't have an additional preference for color."`,
          },
        },
      },
      {
        id: "parse", x: 560, y: 220, w: 380, h: 104, kind: "stage", drill: "parser", badge: "drill",
        label: "② parse_message()", sub: "parser.py · closed-vocab constraints + turn flags",
        detail: {
          ...F("starter/components/parser.py", "116–144"),
          summary: "Deterministic keyword extraction into Constraint(attribute, value, polarity, confidence), plus three booleans that classify the turn: override, boundary, generic_feedback.",
          bullets: [
            "Reliable at what it covers: the closed vocabularies (material, color, brand) and the three turn flags.",
            "Deliberately lossy: any word outside its fixed term tuples is discarded.",
            "Retrieval no longer depends on it for lexical matching — that is what the verbatim snippet path is for.",
          ],
          why: "Recognising the parser's loss instead of extending its vocabulary was the key architectural call: raw text went to retrieval and ranking, while the parser kept only the jobs it does well.",
        },
      },
      {
        id: "store", x: 560, y: 364, w: 380, h: 104, kind: "stage", drill: "session", badge: "drill",
        label: "③ SessionStore.update()", sub: "session_store.py · fold the turn into SessionState",
        detail: {
          ...F("starter/components/session_store.py", "46–128"),
          summary: "The multi-turn memory. Accumulates positive and negative constraints, tracks which attributes are disclosed / asked / explicitly unconstrained, and implements the two special transitions.",
          bullets: [
            "Override: clear only the attribute being replaced, demote its old value to a negative constraint, and re-open it for questioning.",
            "Boundary: mark the last-asked attribute as unconstrained so it is never penalised or asked again.",
            "Also latches category_hint from the turn-1 opener via 'looking for (.+?)[,.]'.",
          ],
        },
      },
      {
        id: "plan", x: 560, y: 508, w: 380, h: 104, kind: "stage", drill: "plan", badge: "drill",
        label: "④ build_search_plan()", sub: "search_plan.py + snippets.py · one query object",
        detail: {
          ...F("starter/components/search_plan.py", "7–54"),
          summary: "Turns accumulated state into a single SearchPlan that both retrieval and ranking read — required terms, excluded terms, and the verbatim disclosure snippets with freshness weights.",
          bullets: [
            "exact_phrases are the raw customer clues, not parser output.",
            "snippet_terms is their flat token set — the tokens retrieval actually matched on.",
            "snippet_weights: 1.0 for post-override text, 0.35 for still-valid pre-override text.",
            "optional_terms come from the user profile's preference_tags.",
          ],
        },
      },
      {
        id: "retrieve", x: 560, y: 652, w: 380, h: 104, kind: "stage", drill: "retrieval", badge: "drill",
        label: "⑤ get_candidates()", sub: "retrieval.py · 4-path FTS5 union → 150 candidates",
        detail: {
          ...F("starter/components/retrieval.py", "130–225"),
          summary: "Recall stage. Four differently-shaped FTS5 queries are unioned; the only job is to make sure the target is somewhere in the pool. Ordering here is loose on purpose.",
          bullets: [
            "Path A — rare-term AND, one query per disclosed snippet, relaxed 4-term → 2-term → OR.",
            "Path C — conjunctive core: AND every clue, dropping the least selective clause until hits appear.",
            "Path C-fallback — broad OR over all query text, for turns with no usable clue.",
            "Path D — category and structured material/color/brand includes.",
            "Pool cutoff is sorted by path tier first, so a real conjunctive match cannot be evicted by a loose OR hit with a numerically higher BM25 score.",
          ],
          constants: [["pool size", "150 (CANDIDATE_POOL_SIZE)"], ["max snippets", "8"], ["recall, fully disclosed", "0.985 @ pool 200"], ["recall, turn 1 only", "0.625 @ pool 200"]],
        },
      },
      {
        id: "rank", x: 560, y: 796, w: 380, h: 104, kind: "stage", drill: "rerank", badge: "drill",
        label: "⑥ rerank()", sub: "rerank.py · deterministic additive score, 11 terms",
        detail: {
          ...F("starter/components/rerank.py", "288–346"),
          summary: "Precision stage. Every pooled product is scored by one additive function — seven rewards and four penalties — and sorted. Fully explainable, no training, no randomness.",
          bullets: [
            "The strongest signals are phrase-level: does a verbatim customer clue appear in the title, or in categories/features/details?",
            "_snippet_coverage gives partial credit per clue, which matters because clues are truncated at 180 characters.",
            "Penalties actively push away wrong colour/material, over-budget items, the wrong category, and items the customer already rejected.",
            "Ties break on rating and review count.",
          ],
          constants: [["coverage weight", "6.0"], ["field weights", "title 5.0 → description 1.0"], ["override boost", "1.5×"]],
        },
      },
      {
        id: "cross", x: 560, y: 940, w: 380, h: 104, kind: "ml", drill: "cross", badge: "drill",
        label: "⑦ cross-encoder rescore", sub: "cross_encoder_rerank.py · top 15 only",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "142–182"),
          summary: "The only learned component. A MS MARCO cross-encoder reads (customer query, product text) jointly and adds a weighted relevance score to the top 15 rule-ranked candidates.",
          bullets: [
            "Cross-encoder, not bi-encoder: the pair is encoded together, which is much stronger at separating rank 1 from rank 3.",
            "Only the top 15 are rescored — the rule stage has already done the recall work.",
            "final = rule_score + 2.0 × cross_encoder_score.",
            "This is a re-ordering stage only: it cannot rescue a target that never made the pool, so it moves MRR, not Hit@10.",
          ],
          constants: [["top_n", "15"], ["weight", "2.0"], ["MRR effect", "0.583 → 0.606"], ["Hit@10 effect", "0.965 → 0.965"]],
        },
      },
      {
        id: "question", x: 560, y: 1084, w: 380, h: 104, kind: "stage", drill: "questions", badge: "drill",
        label: "⑧ choose_question_attribute()", sub: "questions.py · which attribute to ask about next",
        detail: {
          ...F("starter/components/questions.py", "25–53"),
          summary: "Picks the single attribute to ask about. This is the agent's only control over what information it will receive next turn, so it directly drives MTTC.",
          bullets: [
            "Never re-asks an attribute already disclosed, already asked, or marked unconstrained.",
            "Leads with 'feature', which is the bucket classify_constraint assigns most clues to.",
            "Turn ≥ 7 forces 'other', which matches any remaining clue.",
            "After an override, asks directly about the attribute that was just replaced.",
          ],
          constants: [["late-turn switch", "turn ≥ 5 prefers 'other'"], ["hard switch", "turn ≥ 7 → 'other'"]],
        },
      },
      {
        id: "response", x: 560, y: 1220, w: 380, h: 96, kind: "out",
        label: "⑨ response dict", sub: "message · ask_attribute · recommendations[10] · usage",
        detail: {
          ...F("starter/agent.py", "69–74"),
          summary: "The contract-shaped return value. Four keys, nothing more — agent_api_contract.json sets additionalProperties: false.",
          code: {
            lang: "json",
            text:
`{
  "message": "What feature matters most to you?",
  "ask_attribute": "feature",
  "recommendations": [{"parent_asin": "B07XYZ1234"}, ...],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0}
}`,
          },
          bullets: [
            "usage is reported as 0/0 because no LLM is called anywhere in the pipeline.",
            "recommendations is best-first; rank 1 is worth 1.0 MRR, rank 10 only 0.1.",
          ],
        },
      },

      {
        id: "art_state", x: 1070, y: 350, w: 340, h: 130, kind: "artifact",
        label: "SessionState", sub: "positive / negative constraints · disclosed · unconstrained · category_hint",
        detail: {
          ...F("starter/components/models.py", "38–53"),
          summary: "The single mutable object per session. Everything downstream is a pure function of it.",
          code: {
            lang: "python",
            text:
`@dataclass
class SessionState:
    user_profile: dict
    messages: list[str]
    parsed_messages: list[ParsedMessage]
    positive_constraints: dict[str, list[Constraint]]
    negative_constraints: dict[str, list[Constraint]]
    unconstrained_attributes: set[str]
    disclosed_attributes: set[str]
    asked_attributes: set[str]
    last_recommendations: list[str]
    last_asked_attribute: str | None
    query_text: str
    override_count: int
    category_hint: str = ""
    last_search_plan: SearchPlan | None = None`,
          },
          bullets: [
            "parsed_messages keeps every turn's normalized text — this is what the snippet extractor reads.",
            "last_recommendations lets the reranker demote items the customer just rejected.",
            "Frozen dataclasses for Constraint / ParsedMessage / SearchPlan keep the per-turn data flow immutable.",
          ],
        },
      },
      {
        id: "art_plan", x: 1070, y: 500, w: 340, h: 130, kind: "artifact",
        label: "SearchPlan", sub: "required · optional · excluded · exact_phrases · snippet_terms · weights",
        detail: {
          ...F("starter/components/models.py", "24–35"),
          summary: "The shared query object. Retrieval and ranking read the same instance, which is what guarantees they agree on what is being searched for.",
          code: {
            lang: "python",
            text:
`@dataclass(frozen=True)
class SearchPlan:
    required_terms: list[str]
    optional_terms: list[str]
    excluded_terms: list[str]
    exact_phrases: list[str]
    attribute_values: dict[str, list[str]]
    snippet_terms: list[str] = field(default_factory=list)
    snippet_weights: list[float] = field(default_factory=list)`,
          },
        },
      },
      {
        id: "art_pool", x: 1070, y: 650, w: 340, h: 120, kind: "artifact",
        label: "Candidate pool", sub: "150 × Candidate(parent_asin, paths, fts_score)",
        detail: {
          ...F("starter/components/retrieval.py", "36–41"),
          summary: "Which retrieval paths found a product is carried forward as evidence, not thrown away.",
          code: {
            lang: "python",
            text:
`@dataclass
class Candidate:
    parent_asin: str
    paths: set[str] = field(default_factory=set)
    fts_score: float = 0.0`,
          },
          bullets: [
            "paths ⊆ {rare_and, core, structured, category, bm25_all}.",
            "fts_score is the best (highest) BM25 score across the paths that found it, carried into the rerank as its first additive term.",
          ],
        },
      },
      {
        id: "art_scored", x: 1070, y: 790, w: 340, h: 120, kind: "artifact",
        label: "scored: dict[asin → float]", sub: "rule score, then optionally cross-encoder boosted",
        detail: {
          ...F("starter/components/rerank.py", "329–346"),
          summary: "A flat id → score map. Sorting is stable and deterministic: descending score, then ascending parent_asin as the tiebreaker.",
          code: {
            lang: "python",
            text:
`# starter/components/rerank.py:341
if cross_encoder is not None:
    scored = cross_encoder.boost_scores(scored, state, active_plan, catalog)
return [
    parent_asin
    for parent_asin, _score in sorted(scored.items(), key=lambda item: (-item[1], item[0]))
]`,
          },
          why: "The parent_asin tiebreaker means identical scores always produce the same order — reruns are byte-identical, which is what makes A/B comparisons trustworthy.",
        },
      },
    ],
    edges: [
      { from: "in_msg", to: "parse", fromSide: "bottom", toSide: "top" },
      { from: "parse", to: "store", fromSide: "bottom", toSide: "top", label: "ParsedMessage" },
      { from: "store", to: "plan", fromSide: "bottom", toSide: "top", label: "SessionState" },
      { from: "plan", to: "retrieve", fromSide: "bottom", toSide: "top", label: "SearchPlan" },
      { from: "retrieve", to: "rank", fromSide: "bottom", toSide: "top", label: "150 candidates" },
      { from: "rank", to: "cross", fromSide: "bottom", toSide: "top", label: "rule scores" },
      { from: "cross", to: "question", fromSide: "bottom", toSide: "top", label: "final order → Top 10" },
      { from: "question", to: "response", fromSide: "bottom", toSide: "top", label: "ask_attribute" },
      { from: "store", to: "art_state", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "plan", to: "art_plan", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "retrieve", to: "art_pool", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "rank", to: "art_scored", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "load_products", to: "rank", fromSide: "right", toSide: "left", kind: "dashed", label: "products dict", midX: 505, labelY: 250 },
      { from: "build_index", to: "retrieve", fromSide: "right", toSide: "left", kind: "dashed", label: "FTS5 + df", midX: 470, labelY: 600 },
      { from: "warm_up", to: "cross", fromSide: "right", toSide: "left", kind: "dashed", label: "model", midX: 440, labelY: 900 },
    ],
  },

  /* ======================= LEVEL 2 — PARSER ============================== */
  parser: {
    title: "parse_message()",
    subtitle: "starter/components/parser.py — deterministic, closed-vocabulary constraint extraction",
    parent: "pipeline",
    w: 1420, h: 900,
    frames: [{ x: 90, y: 180, w: 1240, h: 210, label: "extractors (all regex, all word-boundary anchored)" }],
    nodes: [
      {
        id: "norm", x: 545, y: 40, w: 330, h: 96, kind: "stage",
        label: "normalize", sub: "strip → lower → collapse whitespace",
        detail: {
          ...F("starter/components/parser.py", "117"),
          summary: "One line, but everything downstream depends on it: the normalized text is stored on ParsedMessage and later becomes the verbatim snippet the reranker phrase-matches with.",
          code: { lang: "python", text: `normalized_text = re.sub(r"\\s+", " ", str(text).strip().lower())` },
          why: "Lower-casing here is why the reranker can compare customer text to product fields with a plain substring test.",
        },
      },
      {
        id: "vocab", x: 120, y: 210, w: 380, h: 170, kind: "stage",
        label: "_extract_term_constraints ×7", sub: "material · color · use_case · size · category · style · feature",
        detail: {
          ...F("starter/components/parser.py", "14–30, 66–72"),
          summary: "Seven fixed term tuples are scanned with word-boundary regexes. A term only becomes a positive constraint if it is not preceded by a negation.",
          code: {
            lang: "python",
            text:
`MATERIAL_TERMS = ("cotton", "polyester", "nylon", "leather", "wool",
                  "spandex", "silk", "rayon", "fabric")
COLOR_TERMS    = ("black", "white", "blue", "red", "pink", "green",
                  "brown", "gray", "grey", "purple", "yellow", "orange")
FEATURE_TERMS  = ("waterproof", "water-resistant", "breathable", "insulated",
                  "non-slip", "comfortable", "durable", "warm", "lightweight",
                  "pockets", "support", "adjustable")

# a term is skipped when negated:
and not re.search(rf"(?:no|without|not|do not want|don't want)\\s+(?:any\\s+)?{term}\\b", text)`,
          },
          constants: [["material terms", "9"], ["color terms", "12"], ["feature terms", "12"], ["category terms", "20"], ["style terms", "10"], ["use-case terms", "6"], ["size terms", "5"]],
          why: "These closed vocabularies align with the evaluator's own MATERIAL_RE / COLOR_RE, so for material and colour the parser and the simulator speak exactly the same language. That is where it earns its keep.",
        },
      },
      {
        id: "regex", x: 530, y: 210, w: 360, h: 170, kind: "stage",
        label: "brand + budget regex", sub: "_extract_brand_constraint · _extract_budget_constraints",
        detail: {
          ...F("starter/components/parser.py", "75–113"),
          summary: "Two open-ended extractors. Budget distinguishes a ceiling from a target price, which the reranker penalises differently.",
          code: {
            lang: "python",
            text:
`patterns = (
    (r"(?:under|below|less than|up to)\\s+\\\$?\\s*(\\d+(?:\\.\\d+)?)", "maximum"),
    (r"\\\$\\s*(\\d+(?:\\.\\d+)?)",                                     "around"),
)
# → Constraint("budget", "maximum $40", "positive", 1.0)

# brand: "brand nike" / "brand under armour" (up to two words)
re.search(r"\\bbrand\\s+([a-z0-9][a-z0-9&'-]*(?:\\s+[a-z0-9][a-z0-9&'-]*)?)", text)`,
          },
          bullets: [
            "Overlapping matches are suppressed by span tracking, so 'under $40' does not also register as 'around $40'.",
            "'maximum' is a hard ceiling — the reranker charges 5.0 plus an overage term for breaching it.",
            "'around' is soft — only penalised beyond a 35% gap.",
            "Brand confidence is 0.9 rather than 1.0, since the pattern is looser.",
          ],
        },
      },
      {
        id: "negation", x: 920, y: 210, w: 380, h: 170, kind: "stage",
        label: "_extract_negative_constraints", sub: "'no cotton', 'without pockets' → polarity: negative",
        detail: {
          ...F("starter/components/parser.py", "92–106"),
          summary: "The same six vocabularies are re-scanned for explicitly rejected values, which become negative constraints rather than being dropped.",
          code: {
            lang: "python",
            text:
`for attribute, terms in term_groups:
    for term in terms:
        if re.search(rf"(?:no|without|not|do not want|don't want)\\s+(?:any\\s+)?{term}\\b", text):
            constraints.append(Constraint(attribute, term, "negative", 1.0))`,
          },
          why: "Negative constraints are worth more than they look: in the reranker an excluded term found in a title costs 4.0 points, which is enough to clear near-duplicate decoys off the top of the list.",
        },
      },
      {
        id: "dedupe", x: 545, y: 425, w: 330, h: 96, kind: "stage",
        label: "de-duplicate", sub: "keyed on (attribute, value, polarity)",
        detail: {
          ...F("starter/components/parser.py", "130–136"),
          summary: "A term repeated in one sentence must not count twice — the reranker's attribute score is additive per value.",
        },
      },
      {
        id: "flags", x: 920, y: 425, w: 380, h: 150, kind: "decision",
        label: "turn-type flags", sub: "override · boundary · generic_feedback",
        detail: {
          ...F("starter/components/parser.py", "31–51, 141–143"),
          summary: "Three phrase-list booleans that classify what kind of turn this is. These drive the two special state transitions and the rejection penalty.",
          code: {
            lang: "python",
            text:
`OVERRIDE_PHRASES = ("actually", "instead", "ignore my earlier preference",
                    "changed my mind", "what i need is", "rather than")
BOUNDARY_PHRASES = ("no preference", "don't care", "use your judgment",
                    "anything is fine", "doesn't matter")
FEEDBACK_PHRASES = ("not quite right", "not what i want", "try again", "not right")`,
          },
          bullets: [
            "These are matched against the exact strings the simulator emits, so detection is effectively perfect.",
            "override → SessionStore._apply_override and a 1.5× rerank boost on the freshest phrases.",
            "boundary → the asked attribute is marked unconstrained, never penalised, never re-asked.",
            "generic_feedback → the previous Top-10 is demoted.",
          ],
          why: "The simulator's wording is fixed and public, so phrase lists are not a hack here — they are the correct, zero-cost way to read a deterministic counterpart.",
        },
      },
      {
        id: "out", x: 545, y: 610, w: 330, h: 130, kind: "out",
        label: "ParsedMessage", sub: "normalized_text · tokens · constraints · 3 flags",
        detail: {
          ...F("starter/components/models.py", "14–21"),
          summary: "Frozen dataclass. normalized_text is the field that matters most downstream — it is the raw material for every snippet.",
          code: {
            lang: "python",
            text:
`@dataclass(frozen=True)
class ParsedMessage:
    normalized_text: str      # <-- the verbatim text retrieval + rerank use
    tokens: list[str]
    constraints: list[Constraint]
    override: bool
    boundary: bool
    generic_feedback: bool`,
          },
        },
      },
      {
        id: "lossy", x: 90, y: 615, w: 400, h: 160, kind: "warn",
        label: "⚠ lossy by design", sub: "why we stopped trying to fix the parser",
        detail: {
          ...F("starter/components/snippets.py", "1–14"),
          summary: "The parser discards every token outside its term tuples. For a disclosed clue like '4.3 oz jersey knit, tagless collar', that means the discriminative words never reach positive_constraints.",
          bullets: [
            "'4.3', 'oz', 'jersey', 'knit', 'tagless' — none are in any vocabulary, yet these are exactly the words that identify one product out of 50,000.",
            "'cotton' does reach the constraints — and matches thousands of products.",
            "The fix was not a bigger vocabulary (unbounded, brittle) but a second channel: components/snippets.py sends the raw text to retrieval and ranking directly.",
            "Measured effect on candidate-pool recall (fully disclosed): 0.860 → 0.985.",
          ],
          why: "Extending a keyword list is a losing race against a 50,000-row catalog. Keeping the customer's own words is free and strictly more informative.",
        },
      },
    ],
    edges: [
      { from: "norm", to: "vocab", fromSide: "bottom", toSide: "top", fromOffset: -0.3 },
      { from: "norm", to: "regex", fromSide: "bottom", toSide: "top" },
      { from: "norm", to: "negation", fromSide: "bottom", toSide: "top", fromOffset: 0.3 },
      { from: "vocab", to: "dedupe", fromSide: "bottom", toSide: "left" },
      { from: "regex", to: "dedupe", fromSide: "bottom", toSide: "top" },
      { from: "negation", to: "dedupe", fromSide: "bottom", toSide: "right" },
      { from: "norm", to: "flags", fromSide: "right", toSide: "top", kind: "dashed", label: "phrase scan" },
      { from: "dedupe", to: "out", fromSide: "bottom", toSide: "top" },
      { from: "flags", to: "out", fromSide: "bottom", toSide: "right" },
      { from: "out", to: "lossy", fromSide: "left", toSide: "right", kind: "dashed" },
    ],
  },

  /* ======================= LEVEL 2 — SESSION STORE ======================= */
  session: {
    title: "SessionStore.update()",
    subtitle: "starter/components/session_store.py — folding turns into state, including the two special transitions",
    parent: "pipeline",
    w: 1420, h: 1040,
    nodes: [
      {
        id: "in", x: 525, y: 40, w: 370, h: 86, kind: "data",
        label: "ParsedMessage + raw text", sub: "appended to state.messages / state.parsed_messages",
        detail: {
          ...F("starter/components/session_store.py", "52–53"),
          summary: "Full history is retained. Nothing is compressed away, because the snippet extractor re-reads every turn on every subsequent turn.",
        },
      },
      {
        id: "ovr_q", x: 525, y: 165, w: 370, h: 90, kind: "decision",
        label: "parsed.override ?", sub: "'actually, ignore my earlier preference…'",
        detail: {
          ...F("starter/components/session_store.py", "55–58"),
          summary: "Fires only on intent_override turns (15% of sessions), so the other three scenarios take a byte-identical path through this function.",
        },
      },
      {
        id: "apply", x: 60, y: 300, w: 400, h: 240, kind: "stage",
        label: "_apply_override()", sub: "surgical replace, not a full wipe",
        detail: {
          ...F("starter/components/session_store.py", "84–128"),
          summary: "The override turn is parsed like any other turn, so the replacement attribute is already known. Only that attribute is cleared — everything else the customer said is still true.",
          bullets: [
            "Clear positive + negative constraints for just the replaced attribute(s); 'category' is never treated as replaced.",
            "Demote the old value to a negative constraint, so the reranker actively pushes the abandoned preference away instead of merely ignoring it.",
            "Discard the attribute from disclosed_attributes and asked_attributes, so questions.py can ask a direct follow-up.",
            "Fall back to the original full wipe (keep category only) when the override turn parses to nothing to anchor on.",
          ],
          code: {
            lang: "python",
            text:
`# starter/components/session_store.py:115
for attribute in overridden_attrs:
    old_positive = state.positive_constraints.pop(attribute, [])
    state.negative_constraints.pop(attribute, None)
    state.disclosed_attributes.discard(attribute)
    state.asked_attributes.discard(attribute)
    for old_constraint in old_positive:
        if old_constraint.value in new_values_by_attr.get(attribute, set()):
            continue
        SessionStore._add_constraint(state, Constraint(
            attribute, old_constraint.value, "negative", old_constraint.confidence))`,
          },
          why: "The earlier version wiped everything except category, which threw away constraints the customer never retracted. Making the replace surgical was one of the two changes that took intent_override from Hit 0.833 to 0.967.",
          constants: [["intent_override Hit", "0.833 → 0.967"], ["intent_override MRR", "0.619 → 0.765"], ["intent_override MTTC", "5.43 → 4.10"]],
        },
      },
      {
        id: "bnd_q", x: 525, y: 300, w: 370, h: 90, kind: "decision",
        label: "parsed.boundary ?", sub: "'I don't have a preference for X'",
        detail: {
          ...F("starter/components/session_store.py", "60–63"),
          summary: "A boundary answer carries no product information, so the turn is used purely to close off an attribute.",
        },
      },
      {
        id: "unconstrained", x: 960, y: 300, w: 400, h: 130, kind: "stage",
        label: "mark unconstrained", sub: "unconstrained_attributes.add(last_asked_attribute)",
        detail: {
          ...F("starter/components/session_store.py", "60–63"),
          summary: "The attribute is recorded as deliberately free. Downstream that has three effects, all of them protective.",
          bullets: [
            "search_plan skips it entirely — no required or excluded terms are generated from it.",
            "rerank skips its attribute score and its colour/material mismatch penalty, so products are not punished for a preference the customer does not hold.",
            "questions.py excludes it, so the turn is never wasted asking again.",
          ],
          why: "Boundary sessions score Hit@10 1.000 — the correct behaviour on 'use your judgment' is to stop constraining, not to guess.",
        },
      },
      {
        id: "add", x: 525, y: 440, w: 370, h: 110, kind: "stage",
        label: "_add_constraint() ×n", sub: "fold into positive_constraints / negative_constraints",
        detail: {
          ...F("starter/components/session_store.py", "64–68, 130–139"),
          summary: "Constraints accumulate across turns, de-duplicated per attribute by value. Disclosing an attribute also clears any earlier 'unconstrained' mark on it.",
          code: {
            lang: "python",
            text:
`# starter/components/session_store.py:64
for constraint in parsed.constraints:
    self._add_constraint(state, constraint)
    state.disclosed_attributes.add(constraint.attribute)
    state.unconstrained_attributes.discard(constraint.attribute)`,
          },
        },
      },
      {
        id: "book", x: 525, y: 600, w: 370, h: 110, kind: "stage",
        label: "re-open replaced attributes", sub: "disclosed_attributes −= overridden_attrs",
        detail: {
          ...F("starter/components/session_store.py", "70–75"),
          summary: "An override reply is often a bare value ('cotton') while the real detail is fuller ('90% Cotton, 10% Others'). Leaving the attribute marked undisclosed lets us ask a direct follow-up for the rest.",
          code: {
            lang: "python",
            text:
`# An override reply is often a single bare value (e.g. "cotton"), not the
# full detail (e.g. "90% Cotton, 10% Others") -- both file under the same
# attribute downstream. Don't treat the replaced attribute as fully
# answered, so questions.py can ask a direct follow-up.
state.disclosed_attributes -= overridden_attrs`,
          },
        },
      },
      {
        id: "hint", x: 60, y: 600, w: 400, h: 110, kind: "stage",
        label: "category_hint (latched once)", sub: "'looking for (.+?)[,.]' on turn 1",
        detail: {
          ...F("starter/components/session_store.py", "9, 78–81"),
          summary: "The coarse product category from the opener, captured once and never overwritten — it survives an override because the customer changes preferences, not product type.",
          code: {
            lang: "python",
            text:
`_CATEGORY_OPENER_RE = re.compile(r"looking for (.+?)[,.]", re.IGNORECASE)

if not state.category_hint and state.messages:
    match = _CATEGORY_OPENER_RE.search(str(state.messages[0]).lower())
    if match:
        state.category_hint = match.group(1).strip()`,
          },
          bullets: [
            "Used by retrieval Path C/D as a clause and as a broad include.",
            "Used by rerank as a penalty: −2.5 when a product's title+categories share almost no tokens with the hint.",
          ],
          why: "The opener is generated from the target's own coarse_category(), so this string is reliable — it is the one piece of the turn-1 message that is always about the right product family.",
        },
      },
      {
        id: "qtext", x: 960, y: 600, w: 400, h: 110, kind: "stage",
        label: "query_text (rebuilt each turn)", sub: "sorted, de-duplicated constraint values",
        detail: {
          ...F("starter/components/session_store.py", "141–152"),
          summary: "A flat bag of every constraint value, excluding unconstrained attributes. Sorted so it is deterministic across runs.",
          bullets: [
            "Only consumed by retrieval's broad-OR fallback path (bm25_all) — the paths that matter use snippets instead.",
            "Sorting by (attribute, value, polarity) rather than turn order means the same state always produces the same query string.",
          ],
        },
      },
      {
        id: "out", x: 525, y: 780, w: 370, h: 96, kind: "out",
        label: "updated SessionState", sub: "the single input to build_search_plan()",
        detail: {
          ...F("starter/components/models.py", "38–53"),
          summary: "Everything after this point is a pure function of this object, which is what makes the pipeline testable turn by turn (tests/test_session_store.py).",
        },
      },
    ],
    edges: [
      { from: "in", to: "ovr_q", fromSide: "bottom", toSide: "top" },
      { from: "ovr_q", to: "apply", fromSide: "left", toSide: "top", label: "yes" },
      { from: "ovr_q", to: "bnd_q", fromSide: "bottom", toSide: "top", label: "no" },
      { from: "apply", to: "add", fromSide: "bottom", toSide: "left", kind: "thin" },
      { from: "bnd_q", to: "unconstrained", fromSide: "right", toSide: "left", label: "yes" },
      { from: "bnd_q", to: "add", fromSide: "bottom", toSide: "top", label: "no" },
      { from: "add", to: "book", fromSide: "bottom", toSide: "top" },
      { from: "book", to: "hint", fromSide: "left", toSide: "right", kind: "thin" },
      { from: "book", to: "qtext", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "book", to: "out", fromSide: "bottom", toSide: "top" },
      { from: "unconstrained", to: "qtext", fromSide: "bottom", toSide: "top", kind: "dashed", label: "excluded" },
    ],
  },

  /* ======================= LEVEL 2 — SEARCH PLAN ========================= */
  plan: {
    title: "build_search_plan() + snippets",
    subtitle: "starter/components/search_plan.py & snippets.py — extracting the customer's own words",
    parent: "pipeline",
    w: 1420, h: 1010,
    frames: [{ x: 495, y: 130, w: 430, h: 560, label: "snippets.py — the verbatim channel" }],
    nodes: [
      {
        id: "msgs", x: 525, y: 40, w: 370, h: 80, kind: "data",
        label: "state.parsed_messages", sub: "every turn's normalized_text, in order",
        detail: {
          ...F("starter/components/snippets.py", "58–76"),
          summary: "Snippets are recomputed from the full history on every turn, not cached — so a late override retro-actively re-weights earlier clues.",
        },
      },
      {
        id: "filter", x: 525, y: 165, w: 370, h: 110, kind: "stage",
        label: "drop no-information turns", sub: "NON_ANSWER_RE",
        detail: {
          ...F("starter/components/snippets.py", "29–34"),
          summary: "Boundary answers, 'no additional preference' non-answers and generic rejections carry no product text. Feeding them to retrieval would inject pure noise tokens.",
          code: {
            lang: "python",
            text:
`NON_ANSWER_RE = re.compile(
    r"(?:do not|don't|dont) have (?:an?|any)\\b[^.]*preference"
    r"|no preference"
    r"|use your judgment"
    r"|not quite right"
)`,
          },
          why: "Without this filter, 'I don't have an additional preference for color' contributes the tokens 'preference' and 'color' to a conjunctive query — enough to make it return nothing.",
        },
      },
      {
        id: "strip", x: 525, y: 315, w: 370, h: 120, kind: "stage",
        label: "strip boilerplate", sub: "text after ':' · OPENER_RE for turn 1",
        detail: {
          ...F("starter/components/snippets.py", "36–37, 66–71"),
          summary: "The simulator wraps every disclosure in fixed scaffolding. Only the payload after the lead-in colon is product text.",
          code: {
            lang: "python",
            text:
`OPENER_RE = re.compile(r"^i'?m looking for .*?[,.]\\s*")

if ":" in text:
    payload = text.split(":", 1)[1]      # "For that, what matters is: X" -> " X"
elif index == 0:
    continue                             # bare opener has no payload
else:
    payload = OPENER_RE.sub("", text)`,
          },
          bullets: [
            "'For that, what matters is: 4.3 oz jersey knit' → '4.3 oz jersey knit'.",
            "'I'm looking for Men's T-Shirts, but I'm still exploring.' → dropped entirely (category is handled separately via category_hint).",
          ],
          why: "'for that what matters is' appears in every disclosure turn, so it has zero discriminative value — but it would dominate a token-overlap score if left in.",
        },
      },
      {
        id: "split", x: 525, y: 475, w: 370, h: 100, kind: "stage",
        label: "split into clues", sub: "SNIPPET_SPLIT_RE = ';' or sentence boundary",
        detail: {
          ...F("starter/components/snippets.py", "38, 72–75"),
          summary: "The simulator joins up to two clues per turn with '; '. Splitting them keeps each clue independently scorable.",
          code: { lang: "python", text: `SNIPPET_SPLIT_RE = re.compile(r";|(?<=\\.)\\s+")` },
          why: "Per-clue granularity is what makes _snippet_coverage meaningful: a product matching one whole clue should beat a product matching scattered tokens from three.",
        },
      },
      {
        id: "weight", x: 960, y: 475, w: 400, h: 150, kind: "stage",
        label: "freshness weights", sub: "1.0 post-override · 0.35 pre-override",
        detail: {
          ...F("starter/components/snippets.py", "40, 92–106"),
          summary: "Pre-override clues are kept but down-weighted, instead of being cut off entirely as in the earlier version.",
          code: {
            lang: "python",
            text:
`_PRE_OVERRIDE_WEIGHT = 0.35

weight = 1.0 if override_start is None or message_index >= override_start \\
              else _PRE_OVERRIDE_WEIGHT`,
          },
          bullets: [
            "The customer replaces one preference, not the whole request — earlier clues usually remain valid.",
            "The weight is applied to both _phrase_score and _snippet_coverage in the reranker.",
            "Hard-cutting pre-override text was the single biggest gap in the pipeline before commit c658e74.",
          ],
          constants: [["pre-override weight", "0.35"], ["post-override weight", "1.0"], ["extra override boost", "1.5× (rerank)"]],
        },
      },
      {
        id: "snips", x: 525, y: 615, w: 370, h: 100, kind: "artifact",
        label: "disclosure_snippets()", sub: "ordered, de-duplicated verbatim clues",
        detail: {
          ...F("starter/components/snippets.py", "79–89"),
          summary: "The output that both retrieval and ranking consume. Shared code, one definition — that was the whole point of splitting this module out.",
          code: {
            lang: "text",
            text:
`["fabric type 100% cotton",
 "4.3 oz jersey knit",
 "tagless collar for comfort",
 "color: navy"]`,
          },
        },
      },
      {
        id: "constraints", x: 60, y: 315, w: 400, h: 180, kind: "stage",
        label: "structured terms", sub: "positive → required_terms · negative → excluded_terms",
        detail: {
          ...F("starter/components/search_plan.py", "8–26"),
          summary: "The parser's structured output becomes required/excluded term lists and an attribute_values map, skipping any attribute the customer marked as unconstrained.",
          code: {
            lang: "python",
            text:
`for attribute, constraints in state.positive_constraints.items():
    if attribute in state.unconstrained_attributes:
        continue
    values = attribute_values.setdefault(attribute, [])
    for constraint in constraints:
        if constraint.value not in values:
            values.append(constraint.value)
            required_terms.append(constraint.value)`,
          },
          bullets: [
            "attribute_values keeps the attribute → value structure, which the reranker needs to know whether a miss is a colour miss (penalised) or a style miss (ignored).",
            "required_terms is a flat list used for token overlap.",
          ],
        },
      },
      {
        id: "tags", x: 60, y: 530, w: 400, h: 120, kind: "stage",
        label: "profile preference_tags", sub: "→ optional_terms (soft, 0.4 each)",
        detail: {
          ...F("starter/components/search_plan.py", "28–32"),
          summary: "The only use of the anonymized user profile. Tags are soft nudges, never constraints.",
          bullets: [
            "user_profile carries aggregate signals only — no item history, so there is nothing stronger to exploit.",
            "Worth 0.4 per matched tag in the reranker: enough to break a tie, never enough to overturn a phrase match.",
          ],
        },
      },
      {
        id: "out", x: 525, y: 780, w: 370, h: 140, kind: "out",
        label: "SearchPlan", sub: "required · optional · excluded · exact_phrases · attribute_values · snippet_terms · snippet_weights",
        detail: {
          ...F("starter/components/search_plan.py", "35–43"),
          summary: "One object, two consumers. Retrieval searches with it; ranking scores with it. That symmetry is deliberate.",
          code: {
            lang: "python",
            text:
`return SearchPlan(
    required_terms=required_terms,
    optional_terms=optional_terms,
    excluded_terms=excluded_terms,
    exact_phrases=exact_phrases,                     # = disclosure_snippets(state)
    attribute_values=attribute_values,
    snippet_terms=snippet_terms(exact_phrases),
    snippet_weights=snippet_weights(state, exact_phrases),
)`,
          },
        },
      },
      {
        id: "why", x: 960, y: 700, w: 400, h: 165, kind: "note",
        label: "★ the core insight", sub: "rank on the same text that retrieved",
        detail: {
          ...F("starter/components/snippets.py", "1–14"),
          summary: "Before this module existed, exact_phrases_for_state returned the whole normalized turn — boilerplate included — which could never substring-match a product field. The strongest positive signal in the scorer was contributing nothing.",
          bullets: [
            "Retrieval was already matching on raw snippets; ranking was matching on thin parser output.",
            "Ranking on a thinner query than the one that found the candidate is precisely what buries correct hits mid-list.",
            "Fixing it, in three cumulative steps: 0.772 → 0.778 (phrases) → 0.783 (snippet terms) → 0.790 (coverage).",
          ],
          why: "This is the lesson worth taking from the whole project: recall and precision must agree on what the query is.",
        },
      },
    ],
    edges: [
      { from: "msgs", to: "filter", fromSide: "bottom", toSide: "top" },
      { from: "filter", to: "strip", fromSide: "bottom", toSide: "top", label: "informative turns" },
      { from: "strip", to: "split", fromSide: "bottom", toSide: "top" },
      { from: "split", to: "snips", fromSide: "bottom", toSide: "top" },
      { from: "split", to: "weight", fromSide: "right", toSide: "left", kind: "thin" },
      { from: "weight", to: "out", fromSide: "left", toSide: "right", kind: "thin", label: "snippet_weights", midX: 925 },
      { from: "snips", to: "out", fromSide: "bottom", toSide: "top", label: "exact_phrases" },
      { from: "constraints", to: "out", fromSide: "bottom", toSide: "left", kind: "thin", toOffset: -0.22 },
      { from: "tags", to: "out", fromSide: "bottom", toSide: "left", kind: "thin", label: "optional", toOffset: 0.22 },
      { from: "snips", to: "why", fromSide: "right", toSide: "left", kind: "dashed" },
    ],
  },

  /* ======================= LEVEL 2 — RETRIEVAL =========================== */
  retrieval: {
    title: "CandidateIndex.get_candidates()",
    subtitle: "starter/components/retrieval.py — four FTS5 paths unioned into one 150-product pool",
    parent: "pipeline",
    w: 1620, h: 1010,
    frames: [{ x: 40, y: 250, w: 1540, h: 225, label: "four retrieval paths — run every turn, results unioned" }],
    nodes: [
      {
        id: "index", x: 60, y: 40, w: 420, h: 170, kind: "init",
        label: "the index (built once)", sub: "FTS5 virtual table + document-frequency Counter",
        detail: {
          ...F("starter/components/retrieval.py", "60–91, 95–108"),
          summary: "A BM25 index with hand-set column weights, queried through SQLite's MATCH operator. The df Counter alongside it is what makes rare-term selection possible.",
          code: {
            lang: "python",
            text:
`_BM25_WEIGHTS = "0.0, 8.0, 5.0, 3.0, 3.0, 1.0, 0.5"
#                 asin title cats feat det desc store

rows = self.connection.execute(
    f"SELECT parent_asin, bm25(products, {_BM25_WEIGHTS}) AS s "
    "FROM products WHERE products MATCH ? ORDER BY s LIMIT ?",
    (expression, limit),
).fetchall()
# bm25() is negative, more-negative = better; flip so bigger = better.
return [(str(asin), -score) for asin, score in rows]`,
          },
          constants: [["title", "8.0"], ["categories", "5.0"], ["features", "3.0"], ["details", "3.0"], ["description", "1.0"], ["store", "0.5"]],
          why: "sqlite3.OperationalError from a malformed MATCH expression is caught and returns an empty list, so one bad query degrades a path instead of failing the turn.",
        },
      },
      {
        id: "inputs", x: 580, y: 40, w: 420, h: 170, kind: "data",
        label: "query inputs", sub: "≤ 8 verbatim snippets + structured material/color/brand + category hint",
        detail: {
          ...F("starter/components/retrieval.py", "144–149"),
          summary: "Two channels, used for what each is good at: verbatim customer text for discriminative matching, parser output for the closed vocabularies.",
          code: {
            lang: "python",
            text:
`snippets = disclosure_snippets(state)
structured = [
    constraint.value
    for attribute in ("material", "color", "brand")
    for constraint in state.positive_constraints.get(attribute, [])
]`,
          },
          constants: [["_MAX_SNIPPETS", "8"]],
        },
      },
      {
        id: "rare", x: 1100, y: 40, w: 460, h: 170, kind: "stage",
        label: "_rare_terms()", sub: "pick the most selective words by document frequency",
        detail: {
          ...F("starter/components/retrieval.py", "110–114"),
          summary: "Given a sentence, return the k words that appear in the fewest catalog rows — and silently drop words that appear in none.",
          code: {
            lang: "python",
            text:
`def _rare_terms(self, snippet: str, k: int = 4) -> list[str]:
    # df == 0 means the token is nowhere in the catalog: keeping it would make
    # any AND it appears in unsatisfiable.
    seen = [t for t in dict.fromkeys(_tokens(snippet)) if self.df.get(t, 0)]
    return sorted(seen, key=lambda t: self.df[t])[:k]`,
          },
          bullets: [
            "'tagless' (df in the hundreds) is worth far more than 'cotton' (df in the thousands) or 'comfort' (df everywhere).",
            "Dropping df == 0 tokens is essential: one unknown word makes an entire AND query return zero rows.",
            "k = 4 for Path A, k = 3 for the conjunctive core.",
          ],
          why: "This is the function that turns a chatty sentence into a precise query. It is also why the stop-word list in snippets.py includes soft marketing words like 'quality', 'great', 'high'.",
        },
      },

      {
        id: "pathA", x: 60, y: 285, w: 350, h: 175, kind: "path",
        label: "Path A — rare_and", sub: "one query per snippet · AND 4 → AND 2 → OR",
        detail: {
          ...F("starter/components/retrieval.py", "151–173"),
          summary: "The highest-precision path. For each disclosed clue, AND together its four rarest words. If that returns almost nothing, progressively relax.",
          code: {
            lang: "python",
            text:
`for snippet in snippets[:_MAX_SNIPPETS]:
    terms = self._rare_terms(snippet, k=4)
    hits = []
    for width in (4, 2):
        if width > len(terms): continue
        hits = self._match(" AND ".join(f'"{t}"' for t in terms[:width]), 80)
        if len(hits) >= 5: break
    if len(hits) < 5:
        if len(terms) > 1:
            hits = self._match(" OR ".join(f'"{t}"' for t in terms), 80)
        else:
            hits = self._match(f'"{terms[0]}"', 80)   # bare override reply
    add("rare_and", hits)`,
          },
          bullets: [
            "A 4-term AND on a truncated or paraphrased clue can legitimately return zero rows — hence the ladder.",
            "The single-term branch was a real bug fix: a bare override reply like 'polyester' yields one rare term, which satisfies neither width 4 nor width 2, so the path used to return nothing at all.",
            "Limit 80 rows per snippet query.",
          ],
          constants: [["widths", "4 → 2 → OR"], ["sufficient hits", "5"], ["row limit", "80"], ["tier", "2 (highest)"]],
        },
      },
      {
        id: "pathC", x: 440, y: 285, w: 350, h: 175, kind: "path",
        label: "Path C — core", sub: "AND every clue · drop least selective until it fits",
        detail: {
          ...F("starter/components/retrieval.py", "175–203"),
          summary: "The cross-clue path. Each clue becomes an OR-group of its own rare terms; the groups are ANDed together; the least selective group is dropped whenever the conjunction is too strict.",
          code: {
            lang: "python",
            text:
`def clause(terms, weight="sum"):
    dfs = [self.df.get(term, 1) for term in terms]
    selectivity = min(dfs) if weight == "min" else sum(dfs)
    clauses.append((selectivity, "(" + " OR ".join(f'"{t}"' for t in terms) + ")"))

clause(_tokens(category))
for snippet in snippets[:_MAX_SNIPPETS]:
    clause(self._rare_terms(snippet, k=3))
for value in structured:
    clause(_tokens(value), weight="min")

clauses.sort(key=lambda item: item[0])       # most selective first
exprs = [expr for _, expr in clauses]
while exprs:
    hits = self._match(" AND ".join(exprs), 150)
    if hits:
        add("core", hits)
        if len(hits) >= 8 or len(exprs) == 1: break
    exprs.pop()                              # drop least selective, retry`,
          },
          bullets: [
            "OR inside a clause tolerates truncation and paraphrase; AND across clauses enforces that all clues hold.",
            "Structured values use min(df) rather than sum(df), because a two-word colour like 'navy blue' should be judged by its rarest word.",
            "A product found by this path satisfies every clue simultaneously — the strongest recall evidence available.",
          ],
          constants: [["clue terms", "k = 3"], ["row limit", "150"], ["stop at", "≥ 8 hits"], ["tier", "2 (highest)"]],
        },
      },
      {
        id: "pathF", x: 820, y: 285, w: 350, h: 175, kind: "path",
        label: "Path C-fallback — bm25_all", sub: "broad OR over all query text · ≤ 40 terms",
        detail: {
          ...F("starter/components/retrieval.py", "205–208"),
          summary: "The safety net. On turns where every conjunctive path fails, a plain BM25 OR still returns something rankable.",
          code: {
            lang: "python",
            text:
`fallback_text = " ".join([getattr(state, "query_text", "") or "", *snippets])
terms = list(dict.fromkeys(_tokens(fallback_text)))[:40]
add("bm25_all", self._match(" OR ".join(f'"{t}"' for t in terms), 100))`,
          },
          bullets: [
            "This is essentially the weak-BM25 starter baseline, kept as the lowest tier.",
            "Tier 0: its candidates are the first evicted when the pool overflows.",
          ],
          constants: [["max terms", "40"], ["row limit", "100"], ["tier", "0 (lowest)"]],
        },
      },
      {
        id: "pathD", x: 1200, y: 285, w: 360, h: 175, kind: "path",
        label: "Path D — category + structured", sub: "category hint OR · one query per structured value",
        detail: {
          ...F("starter/components/retrieval.py", "210–214"),
          summary: "Breadth insurance from the two things we are most confident about: the product family from the opener, and any closed-vocabulary attribute the parser resolved.",
          code: {
            lang: "python",
            text:
`add("category", self._match(" OR ".join(f'"{t}"' for t in _tokens(category)), 80))
for value in structured:
    value_terms = list(dict.fromkeys(_tokens(value)))
    add("structured", self._match(" OR ".join(f'"{t}"' for t in value_terms), 50))`,
          },
          constants: [["category tier", "0"], ["structured tier", "1"], ["row limits", "80 / 50"]],
        },
      },

      {
        id: "union", x: 620, y: 530, w: 400, h: 120, kind: "stage",
        label: "union the paths", sub: "dict keyed on parent_asin · keep max fts_score · accumulate paths",
        detail: {
          ...F("starter/components/retrieval.py", "133–137"),
          summary: "Paths overlap heavily, and that overlap is signal: a product found by three paths is more likely correct than one found by a single broad OR.",
          code: {
            lang: "python",
            text:
`def add(path: str, hits: list[tuple[str, float]]) -> None:
    for parent_asin, score in hits:
        candidate = pool.setdefault(parent_asin, Candidate(parent_asin))
        candidate.paths.add(path)
        candidate.fts_score = max(candidate.fts_score, score)`,
          },
        },
      },
      {
        id: "tier", x: 620, y: 700, w: 400, h: 150, kind: "stage",
        label: "tiered pool cutoff", sub: "sort by (path tier, path count, BM25) then take 150",
        detail: {
          ...F("starter/components/retrieval.py", "26–33, 216–225"),
          summary: "Raw BM25 scores are not comparable across differently-shaped queries. Sorting by path specificity first prevents a loose match from evicting a genuine conjunctive one.",
          code: {
            lang: "python",
            text:
`_PATH_TIER = {"core": 2, "rare_and": 2, "structured": 1,
              "category": 0, "bm25_all": 0}

ordered = sorted(
    pool.values(),
    key=lambda candidate: (
        max(_PATH_TIER.get(path, 0) for path in candidate.paths),
        len(candidate.paths),
        candidate.fts_score,
    ),
    reverse=True,
)
return ordered[:pool_size]`,
          },
          bullets: [
            "A short generic OR query concentrates BM25's IDF term over fewer words and can numerically outscore a much stronger multi-clause AND match.",
            "Fixing the sort key lifted browsing Hit@10 0.938 → 0.950 and intent_override 0.800 → 0.833, with buying and boundary byte-identical (commit 7e7aa0e).",
          ],
          why: "A subtle but instructive failure: the bug was not in any query, it was in comparing scores that were never on the same scale.",
        },
      },
      {
        id: "out", x: 620, y: 890, w: 400, h: 96, kind: "out",
        label: "150 Candidates", sub: "loosely ordered — ranking is a separate concern",
        detail: {
          ...F("starter/components/retrieval.py", "1–6"),
          summary: "The pool's only job is to contain the target. Ordering it well is explicitly not this module's responsibility.",
          why: "Separating recall from precision is what allowed both to be tuned independently — and measured independently, via scripts/recall_check.py.",
        },
      },
      {
        id: "recall", x: 1100, y: 660, w: 460, h: 180, kind: "note",
        label: "measured recall", sub: "scripts/recall_check.py — is the target in the pool?",
        detail: {
          ...F("scripts/recall_check.py", null),
          summary: "A dedicated harness that replays the evaluator's own simulated turns and asks only one question: did the target make the pool? It isolates retrieval from every ranking decision.",
          table: {
            head: ["pool", "disclosure", "recall", "boundary", "browsing", "buying", "override"],
            rows: [
              ["100", "turn 1 only", "0.425", "0.40", "0.36", "0.46", "0.50"],
              ["100", "all turns", "0.935", "1.00", "0.96", "0.96", "0.77"],
              ["200", "turn 1 only", "0.625", "0.40", "0.46", "0.81", "0.63"],
              ["200", "all turns", "0.985", "1.00", "1.00", "0.99", "0.93"],
              ["400", "turn 1 only", "0.630", "0.40", "0.46", "0.82", "0.63"],
              ["400", "all turns", "0.990", "1.00", "1.00", "0.99", "0.97"],
            ],
          },
          bullets: [
            "Feeding verbatim snippets instead of parser output moved fully-disclosed recall from 0.860 to 0.985.",
            "Pool 200 → 400 buys 0.005 recall for double the ranking work, which is why the agent ships at 150.",
            "The stand-in agent always asks 'other', so these are an upper bound over question policies only.",
          ],
          why: "0.985 recall against a 0.965 hit rate says the pool is no longer the bottleneck — ranking is. That measurement is what redirected effort to the reranker and then to the cross-encoder.",
        },
      },
    ],
    edges: [
      { from: "inputs", to: "pathA", fromSide: "bottom", toSide: "top", fromOffset: -0.35 },
      { from: "inputs", to: "pathC", fromSide: "bottom", toSide: "top", fromOffset: -0.1 },
      { from: "inputs", to: "pathF", fromSide: "bottom", toSide: "top", fromOffset: 0.15 },
      { from: "inputs", to: "pathD", fromSide: "bottom", toSide: "top", fromOffset: 0.35 },
      { from: "index", to: "pathA", fromSide: "bottom", toSide: "top", kind: "dashed", label: "MATCH", bus: 232, toOffset: -0.3 },
      { from: "rare", to: "pathC", fromSide: "bottom", toSide: "top", kind: "dashed", label: "df", bus: 262, toOffset: 0.3 },
      { from: "pathA", to: "union", fromSide: "bottom", toSide: "left" },
      { from: "pathC", to: "union", fromSide: "bottom", toSide: "top", fromOffset: -0.1 },
      { from: "pathF", to: "union", fromSide: "bottom", toSide: "top", fromOffset: 0.2 },
      { from: "pathD", to: "union", fromSide: "bottom", toSide: "right" },
      { from: "union", to: "tier", fromSide: "bottom", toSide: "top" },
      { from: "tier", to: "out", fromSide: "bottom", toSide: "top" },
      { from: "tier", to: "recall", fromSide: "right", toSide: "left", kind: "dashed", label: "measured by" },
    ],
  },

  /* ======================= LEVEL 2 — RERANK ============================== */
  rerank: {
    title: "rerank() — the additive scoring model",
    subtitle: "starter/components/rerank.py — seven rewards, four penalties, one number per product",
    parent: "pipeline",
    w: 1640, h: 1120,
    frames: [
      { x: 60, y: 300, w: 460, h: 640, label: "+ rewards" },
      { x: 1120, y: 300, w: 460, h: 460, label: "− penalties" },
    ],
    nodes: [
      {
        id: "in", x: 620, y: 40, w: 400, h: 100, kind: "data",
        label: "inputs", sub: "150 candidates · SearchPlan · SessionState · products dict",
        detail: {
          ...F("starter/components/rerank.py", "319–346"),
          summary: "Every pooled id is scored independently — no pairwise comparisons, no learned weights, no randomness. Same inputs always produce the same order.",
          code: {
            lang: "python",
            text:
`for candidate in candidates:
    parent_asin = str(candidate.get("parent_asin", "")).strip()
    product = catalog.get(parent_asin, candidate)
    retrieval = candidate.get("retrieval_score", 0.0)
    total = score_product(product, state, active_plan, float(retrieval))
    if scored.get(parent_asin) is None or total > scored[parent_asin]:
        scored[parent_asin] = total`,
          },
          why: "Determinism is a feature, not a limitation: it made every one of the seven scoring experiments in this project a clean A/B with no variance to average out.",
        },
      },
      {
        id: "fields", x: 620, y: 180, w: 400, h: 120, kind: "stage",
        label: "_field_map + _canonical", sub: "flatten the product row · punctuation-insensitive matching",
        detail: {
          ...F("starter/components/rerank.py", "50–83"),
          summary: "Product fields are flattened to lower-case strings, and both sides of a phrase test are reduced to a punctuation-free, space-padded form.",
          code: {
            lang: "python",
            text:
`def _canonical(text: str) -> str:
    """Punctuation-free, space-padded form: ' fabric type 100 cotton '."""
    return " " + NON_ALNUM_RE.sub(" ", text).strip() + " "

# details {"Fabric type": "100% Cotton"} flattens to "fabric type 100% cotton",
# but the customer says "fabric type: 100% cotton" -- a plain substring test
# fails on the colon alone.`,
          },
          bullets: [
            "Padding with spaces keeps matches on token boundaries: 'cotton' must not match 'cottonwood'.",
            "A dict field becomes 'key value key value …'; a list field becomes its items joined.",
            "This single normalisation is what made the phrase bonus start firing on real targets.",
          ],
        },
      },

      {
        id: "r1", x: 90, y: 340, w: 400, h: 76, kind: "plus",
        label: "+ retrieval_score", sub: "carried BM25 from the winning path",
        detail: {
          ...F("starter/components/rerank.py", "304–305"),
          summary: "The pool's own BM25 score enters unmodified as the first additive term.",
          bullets: [
            "Not normalised and not weighted — a known rough edge, flagged in the open items as never having been sensitivity-checked against the much larger snippet signals.",
            "Because Candidate.fts_score is the max across paths, this term implicitly rewards being found by a strong path.",
          ],
        },
      },
      {
        id: "r2", x: 90, y: 430, w: 400, h: 76, kind: "plus",
        label: "+ _phrase_score", sub: "verbatim clue in title 5.0 · cats/features/details 2.5 · description 1.0",
        detail: {
          ...F("starter/components/rerank.py", "85–107"),
          summary: "The strongest single signal. If a whole customer clue appears verbatim inside a product field, that product is almost certainly the target.",
          code: {
            lang: "python",
            text:
`for index, phrase in enumerate(phrases):
    needle = _canonical(phrase)
    weight = weights[index] if weights and index < len(weights) else 1.0
    if   needle in title:       score += 5.0 * weight
    elif needle in strong:      score += 2.5 * weight   # categories+features+details
    elif needle in description: score += 1.0 * weight`,
          },
          bullets: [
            "Multiplied by snippet_weights (0.35 pre-override, 1.0 post-override).",
            "Multiplied again by _override_boost (1.5×) on an override turn.",
            "All-or-nothing per clue — which is exactly why _snippet_coverage exists alongside it.",
            "Zeroing this term while keeping coverage costs 0.009 TechnicalScore, so both earn their place.",
          ],
          constants: [["title hit", "5.0"], ["strong-field hit", "2.5"], ["description hit", "1.0"], ["override turn", "× 1.5"]],
        },
      },
      {
        id: "r3", x: 90, y: 520, w: 400, h: 76, kind: "plus",
        label: "+ _snippet_coverage", sub: "6.0 × (share of clue tokens found), per clue",
        detail: {
          ...F("starter/components/rerank.py", "110–134"),
          summary: "Partial credit where the exact phrase is all-or-nothing. Each clue is scored by the fraction of its tokens present in the product's strong fields.",
          code: {
            lang: "python",
            text:
`_COVERAGE_WEIGHT = 6.0

for index, snippet in enumerate(snippets):
    terms = snippet_tokens(snippet)
    weight = weights[index] if weights and index < len(weights) else 1.0
    score += weight * _COVERAGE_WEIGHT * sum(1 for t in terms if t in strong) / len(terms)`,
          },
          bullets: [
            "Necessary because the evaluator truncates every disclosed constraint at 180 characters, sometimes mid-word — so the exact phrase misses even on the true target.",
            "Kept per clue rather than pooled: unlike token overlap, one long clue cannot drown out three short ones.",
            "_COVERAGE_WEIGHT is flat over roughly 5–12 and degrades at 20; it ships at 6.0.",
          ],
          constants: [["_COVERAGE_WEIGHT", "6.0"], ["tuning plateau", "5–12"], ["degrades at", "20"]],
          why: "This term alone was worth 0.007 TechnicalScore on top of the phrase and snippet-term changes.",
        },
      },
      {
        id: "r4", x: 90, y: 610, w: 400, h: 76, kind: "plus",
        label: "+ _token_overlap", sub: "field-weighted: title 5.0 → description 1.0",
        detail: {
          ...F("starter/components/rerank.py", "18–25, 137–149"),
          summary: "Bag-of-words backstop over required terms, snippet terms and optional terms, weighted by which field the token was found in.",
          code: {
            lang: "python",
            text:
`_FIELD_WEIGHTS = {"title": 5.0, "categories": 3.0, "features": 2.5,
                  "details": 2.0, "store": 1.5, "description": 1.0}

query_terms = list(dict.fromkeys([*plan.required_terms,
                                  *plan.snippet_terms,      # what the parser drops
                                  *plan.optional_terms]))`,
          },
          bullets: [
            "Folding snippet_terms in here is what let words like 'jersey' and 'tagless' influence ranking at all.",
            "Normalised by the number of unique query tokens, so a long query does not inflate scores.",
          ],
        },
      },
      {
        id: "r5", x: 90, y: 700, w: 400, h: 76, kind: "plus",
        label: "+ _attribute_score", sub: "hard attribute 2.5 · soft 1.5 · description-only 0.75 · miss −1.5",
        detail: {
          ...F("starter/components/rerank.py", "29, 152–170"),
          summary: "Structured containment check per attribute value, with an asymmetry: missing a material, colour or category is actively penalised, while missing a style is merely not rewarded.",
          code: {
            lang: "python",
            text:
`_HARD_ATTRIBUTES = ("category", "material", "color", "size",
                    "style", "brand", "feature", "use_case")

for attribute, values in plan.attribute_values.items():
    if attribute in unconstrained: continue          # boundary answers
    for value in values:
        if   _contains(blob, value):        score += 2.5 if attribute in _HARD_ATTRIBUTES else 1.5
        elif _contains(description, value): score += 0.75
        elif attribute in ("material", "color", "category"): score -= 1.5`,
          },
          bullets: [
            "'unconstrained' attributes are skipped entirely — a boundary answer must never cost a product points.",
            "Only material, colour and category are penalised on a miss, because only those are reliably stated in catalog rows.",
          ],
        },
      },
      {
        id: "r6", x: 90, y: 790, w: 400, h: 76, kind: "plus",
        label: "+ _optional_score", sub: "0.4 per matched profile preference_tag",
        detail: {
          ...F("starter/components/rerank.py", "173–175"),
          summary: "Soft personalisation from the anonymized profile. Deliberately small: it should break ties, never overturn evidence.",
        },
      },
      {
        id: "r7", x: 90, y: 880, w: 400, h: 76, kind: "plus",
        label: "+ _quality_tiebreak", sub: "0.05 × rating + 0.015 × log1p(reviews)",
        detail: {
          ...F("starter/components/rerank.py", "239–244"),
          summary: "Sub-point nudge toward well-reviewed products, for when everything else is equal.",
          code: {
            lang: "python",
            text:
`return 0.05 * rating_value + 0.015 * math.log1p(max(count_value, 0.0))`,
          },
          bullets: [
            "Maximum realistic contribution is well under 0.5 points, versus 5.0 for a title phrase hit.",
            "log1p keeps a product with 50,000 reviews from dominating one with 500.",
            "Listed in the open items as never having been sensitivity-checked — a cheap remaining experiment.",
          ],
        },
      },

      {
        id: "p1", x: 1150, y: 340, w: 400, h: 76, kind: "minus",
        label: "− _contradiction_penalty", sub: "excluded term in title 4.0 · colour/material mismatch 3.5",
        detail: {
          ...F("starter/components/rerank.py", "178–214"),
          summary: "Two mechanisms: explicitly rejected terms, and the sharper 'mentions a colour, but not yours' test.",
          code: {
            lang: "python",
            text:
`for term in plan.excluded_terms:
    if   _contains(title, term):       penalty += 4.0
    elif _contains(strong, term):      penalty += 2.5
    elif _contains(description, term): penalty += 1.0

# a product that names colours but never the required one is wrong
if required_colors:
    mentioned = [c for c in COLOR_TERMS if _contains(strong, c)]
    if mentioned and not any(c in mentioned for c in required_colors):
        penalty += 3.5`,
          },
          bullets: [
            "The 'mentioned but not matching' guard is careful: a product that lists no colour at all is not penalised, only one that lists the wrong one.",
            "This is where an override's demoted old value does its work — 'polyester' becomes an excluded term worth −4.0 in a title.",
          ],
          constants: [["title", "−4.0"], ["strong fields", "−2.5"], ["description", "−1.0"], ["colour mismatch", "−3.5"], ["material mismatch", "−3.5"]],
        },
      },
      {
        id: "p2", x: 1150, y: 430, w: 400, h: 76, kind: "minus",
        label: "− _budget_penalty", sub: "over a ceiling 5.0+ · off a target price by >35%",
        detail: {
          ...F("starter/components/rerank.py", "217–236"),
          summary: "Two budget qualifiers, penalised very differently, because 'under $40' and '$40' mean different things.",
          code: {
            lang: "python",
            text:
`if qualifier == "maximum" and price > amount:
    penalty += 5.0 + min(4.0, (price - amount) / max(amount, 1.0))
elif qualifier == "around":
    gap = abs(price - amount) / max(amount, 1.0)
    if gap > 0.35:
        penalty += 2.0 * gap`,
          },
          bullets: [
            "'maximum' is a hard breach: 5.0 flat plus a proportional overage capped at 4.0.",
            "'around' allows a 35% tolerance band before any penalty at all.",
            "Products with price: null are never penalised — absent data must not be read as a violation.",
            "Skipped entirely when budget is an unconstrained attribute.",
          ],
        },
      },
      {
        id: "p3", x: 1150, y: 520, w: 400, h: 76, kind: "minus",
        label: "− _feedback_penalty", sub: "1.5 − 0.1 × previous rank, after a rejection",
        detail: {
          ...F("starter/components/rerank.py", "247–257"),
          summary: "When the customer says 'not quite right' or overrides, the products we just showed are demoted — hardest at the top of the old list.",
          code: {
            lang: "python",
            text:
`last = state.parsed_messages[-1]
if not (last.generic_feedback or last.override):
    return 0.0
rank = state.last_recommendations.index(parent_asin)
return 1.5 - (0.1 * rank)`,
          },
          bullets: [
            "Rank 1 loses 1.5; rank 10 loses only 0.6 — the item we were most confident about was the most wrong.",
            "Applied for exactly one turn, so a genuinely good candidate can climb back.",
            "Fires on override turns too: the recommendations that led to the correction are evidence about what not to show.",
          ],
        },
      },
      {
        id: "p4", x: 1150, y: 610, w: 400, h: 76, kind: "minus",
        label: "− _category_mismatch_penalty", sub: "flat 2.5 when the product family is wrong",
        detail: {
          ...F("starter/components/rerank.py", "260–273"),
          summary: "Checks the opener's category hint against the product's title and categories, and charges a flat penalty when they barely overlap.",
          code: {
            lang: "python",
            text:
`overlap = sum(1 for token in hint_tokens if token in product_tokens)
if overlap >= max(1, len(hint_tokens) // 3):
    return 0.0
return 2.5`,
          },
          bullets: [
            "Threshold is a third of the hint's tokens, so 'men's short sleeve t-shirts' matching only 't-shirts' still passes.",
            "Products with no title or categories are not penalised.",
            "Added in commit c658e74 as part of the change that closed the intent_override gap.",
          ],
        },
      },

      {
        id: "sum", x: 620, y: 560, w: 400, h: 150, kind: "score",
        label: "score_product()", sub: "one additive expression · 11 terms",
        detail: {
          ...F("starter/components/rerank.py", "288–316"),
          summary: "The whole ranking model, readable in one screen. Every term is inspectable, and every weight was set by measuring TechnicalScore on the public set.",
          code: {
            lang: "python",
            text:
`return (
    retrieval_score
    + _override_boost(state) * _phrase_score(fields, plan.exact_phrases, phrase_weights)
    + _snippet_coverage(fields, plan.exact_phrases, phrase_weights)
    + _token_overlap(fields, query_terms)
    + _attribute_score(fields, plan, unconstrained)
    + _optional_score(fields, plan.optional_terms)
    + _quality_tiebreak(product)
    - _contradiction_penalty(fields, plan, unconstrained)
    - _budget_penalty(product, plan, unconstrained)
    - _feedback_penalty(str(product.get("parent_asin", "")), state)
    - _category_mismatch_penalty(fields, state)
)`,
          },
          why: "An additive model was chosen over a learned ranker for three reasons: no training data exists, the rules encode exactly what the simulator does, and any regression can be attributed to a single term.",
        },
      },
      {
        id: "out", x: 620, y: 940, w: 400, h: 100, kind: "out",
        label: "ordered ids", sub: "sorted by (−score, parent_asin) → Top 10",
        detail: {
          ...F("starter/components/rerank.py", "343–346"),
          summary: "Descending score, with parent_asin as a deterministic tiebreaker so reruns are byte-identical.",
        },
      },
    ],
    edges: [
      { from: "in", to: "fields", fromSide: "bottom", toSide: "top" },
      { from: "fields", to: "sum", fromSide: "bottom", toSide: "top" },
      { from: "r1", to: "sum", fromSide: "right", toSide: "left", kind: "thin", fromOffset: 0, midX: 555 },
      { from: "r2", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 545 },
      { from: "r3", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 535 },
      { from: "r4", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 570 },
      { from: "r5", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 560 },
      { from: "r6", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 550 },
      { from: "r7", to: "sum", fromSide: "right", toSide: "left", kind: "thin", midX: 540 },
      { from: "p1", to: "sum", fromSide: "left", toSide: "right", kind: "thin", midX: 1085 },
      { from: "p2", to: "sum", fromSide: "left", toSide: "right", kind: "thin", midX: 1095 },
      { from: "p3", to: "sum", fromSide: "left", toSide: "right", kind: "thin", midX: 1105 },
      { from: "p4", to: "sum", fromSide: "left", toSide: "right", kind: "thin", midX: 1115 },
      { from: "sum", to: "out", fromSide: "bottom", toSide: "top" },
    ],
  },

  /* ======================= LEVEL 2 — CROSS ENCODER ======================= */
  cross: {
    title: "Cross-encoder second stage",
    subtitle: "starter/components/cross_encoder_rerank.py — the only learned component in the pipeline",
    parent: "pipeline",
    w: 1420, h: 1000,
    nodes: [
      {
        id: "in", x: 520, y: 40, w: 380, h: 96, kind: "data",
        label: "rule scores", sub: "dict[parent_asin → float] from rerank()",
        detail: {
          ...F("starter/components/rerank.py", "341–342"),
          summary: "The cross-encoder is a post-processor on the rule model's output, not a replacement for it.",
          code: {
            lang: "python",
            text:
`if cross_encoder is not None:
    scored = cross_encoder.boost_scores(scored, state, active_plan, catalog)`,
          },
        },
      },
      {
        id: "gate", x: 520, y: 175, w: 380, h: 120, kind: "decision",
        label: "enabled?", sub: "env flag · model loaded · non-empty query",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "106–140, 149–154"),
          summary: "Three guards, all of which return the untouched rule scores rather than raising. The stage can never break a turn.",
          code: {
            lang: "python",
            text:
`if not self.enabled or not scores:
    return dict(scores)
query = build_query_text(state, plan)
if not query:
    return dict(scores)`,
          },
          bullets: [
            "TECHJAM_CROSS_ENCODER_DISABLE=1 opts out entirely (used for rule-only baselines).",
            "A missing sentence-transformers install is handled: warm_up pip-installs from requirements.txt; a lazy path just disables the stage.",
            "A model load failure raises only during warm_up, never mid-session.",
          ],
          constants: [["TECHJAM_CROSS_ENCODER_DISABLE", "opt out"], ["TECHJAM_CROSS_ENCODER_TOP_N", "default 15"], ["TECHJAM_CROSS_ENCODER_WEIGHT", "default 2.0"]],
        },
      },
      {
        id: "topn", x: 520, y: 335, w: 380, h: 100, kind: "stage",
        label: "take top 15", sub: "sorted by rule score",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "156–159"),
          summary: "Only the head of the list is rescored. A transformer forward pass per candidate is the expensive operation here, and the rule stage has already handled recall.",
          bullets: [
            "15 pairs per turn instead of 150 — a 10× saving with no measured loss (the sweep tested 10, 15 and 20).",
            "The target is inside the Top 10 in 96.5% of sessions, so 15 comfortably covers what needs reordering.",
            "This is a re-ranking stage only: a target that never made the pool cannot be recovered here, which is why Hit@10 is unchanged at 0.965.",
          ],
          constants: [["top_n", "15"], ["pairs scored/turn", "≤ 15"]],
        },
      },
      {
        id: "query", x: 60, y: 335, w: 400, h: 150, kind: "stage",
        label: "build_query_text()", sub: "category hint + verbatim clues + required terms",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "79–86"),
          summary: "The query side of the pair — the same verbatim snippets the rest of the pipeline uses, prefixed with the product family.",
          code: {
            lang: "python",
            text:
`def build_query_text(state: SessionState, plan: SearchPlan) -> str:
    parts: list[str] = []
    hint = str(getattr(state, "category_hint", "") or "").strip()
    if hint:
        parts.append(hint)
    parts.extend(plan.exact_phrases)
    parts.extend(plan.required_terms)
    return " ".join(part for part in parts if part).strip()`,
          },
          why: "MS MARCO models are trained on natural-language queries against passages, so feeding a fluent sentence like \"men's t-shirts fabric type 100% cotton 4.3 oz jersey knit\" is closer to their training distribution than a keyword bag would be.",
        },
      },
      {
        id: "prod", x: 960, y: 335, w: 400, h: 150, kind: "stage",
        label: "build_product_text()", sub: "title + categories + features + details",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "89–99"),
          summary: "The passage side of the pair. description is excluded — it is long, marketing-heavy and would dilute the discriminative fields within the model's token budget.",
          code: {
            lang: "python",
            text:
`def build_product_text(product: Mapping[str, object]) -> str:
    return _normalize(" ".join([
        _as_text(product.get("title")),
        _as_text(product.get("categories")),
        _as_text(product.get("features")),
        _as_text(product.get("details")),
    ]))`,
          },
          bullets: [
            "Case is preserved here (unlike the rule reranker) because the model was trained on natural cased text.",
            "Products that flatten to an empty string are skipped rather than scored on nothing.",
          ],
        },
      },
      {
        id: "predict", x: 520, y: 490, w: 380, h: 120, kind: "ml",
        label: "CrossEncoder.predict(pairs)", sub: "ms-marco-MiniLM-L-6-v2 · joint encoding",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "24, 176–177"),
          summary: "A 6-layer MiniLM cross-encoder reads query and product together in one sequence and emits a single relevance logit per pair.",
          bullets: [
            "Cross-encoder, not bi-encoder: query and passage attend to each other, which is markedly better at fine-grained separation than comparing two independent embeddings.",
            "Pretrained on MS MARCO passage ranking. Not fine-tuned on competition data — no training was performed, which keeps us inside the rules.",
            "Runs on CPU. Adds roughly 5–15× to evaluation wall-clock versus rule-only.",
          ],
          constants: [["model", "cross-encoder/ms-marco-MiniLM-L-6-v2"], ["layers", "6"], ["size", "~90 MB"], ["fine-tuning", "none"]],
          why: "The remaining error was ordering, not retrieval — targets sat at rank 2–3. A cross-encoder is the standard, cheapest correct tool for exactly that problem.",
        },
      },
      {
        id: "blend", x: 520, y: 665, w: 380, h: 120, kind: "stage",
        label: "blend", sub: "final = rule_score + 2.0 × cross_score",
        detail: {
          ...F("starter/components/cross_encoder_rerank.py", "179–182"),
          summary: "Additive blend, not replacement. The rule score's hard evidence — budget breaches, colour contradictions, rejected items — still counts.",
          code: {
            lang: "python",
            text:
`boosted = dict(scores)
for parent_asin, cross_score in zip(valid_asins, cross_scores, strict=True):
    boosted[parent_asin] = boosted[parent_asin] + _cross_encoder_weight() * float(cross_score)
return boosted`,
          },
          bullets: [
            "strict=True on the zip: a length mismatch fails loudly rather than silently misaligning scores with ids.",
            "Weight 2.0 was the sweep optimum; 1.0 and 3.0 were both within 0.005 TechnicalScore, so the setting is not brittle.",
            "Only the top 15 receive a boost, so the tail keeps its pure rule ordering.",
          ],
        },
      },
      {
        id: "out", x: 520, y: 840, w: 380, h: 96, kind: "out",
        label: "boosted scores", sub: "re-sorted → Top 10",
        detail: {
          summary: "Measured effect on the full public set: MRR 0.583 → 0.606, TechnicalScore 0.817 → 0.824, Hit@10 unchanged at 0.965.",
          bullets: [
            "Exactly the expected shape for a re-ranking stage: ordering improves, recall does not.",
            "Per scenario, intent_override MRR rose most (0.690 → 0.765).",
            "boundary MRR moved the other way (0.613 → 0.555) on only 10 sessions — one rank change is worth 0.05 MRR there, so it is noise-dominated.",
          ],
          constants: [["MRR", "0.583 → 0.606"], ["TechnicalScore", "0.817 → 0.824"], ["Hit@10", "0.965 → 0.965"]],
          why: "Reporting the boundary dip alongside the win matters: on a 10-session bucket, a single rank movement dominates the metric.",
        },
      },
      {
        id: "sweep", x: 960, y: 585, w: 400, h: 165, kind: "note",
        label: "hyper-parameter sweep", sub: "scripts/cross_encoder_sweep.py · 50-session quick mode",
        detail: {
          ...F("scripts/cross_encoder_sweep.py", null),
          summary: "top_n × weight grid, scored against a rule-only baseline on the same subset.",
          table: {
            head: ["top_n", "weight", "TechScore", "MRR", "sec"],
            rows: [
              ["—", "baseline", "0.846", "0.584", "—"],
              ["15", "2.0", "0.867", "0.657", "14.9"],
              ["15", "1.0", "0.866", "0.651", "14.5"],
              ["20", "2.0", "0.863", "0.643", "17.0"],
              ["15", "3.0", "0.862", "0.639", "14.0"],
              ["10", "2.0", "0.859", "0.626", "11.5"],
            ],
          },
          bullets: [
            "Every configuration beat the baseline, and all nine landed within 0.008 of each other — the gain is from having the stage at all, not from the exact setting.",
            "top_n = 15 at weight 2.0 won and became the default.",
            "Tuned on a 50-session public subset, so generalisation to the 800-session private split is genuinely unverified — this is stated openly in the README's limitations.",
          ],
        },
      },
      {
        id: "offline", x: 60, y: 585, w: 400, h: 165, kind: "warn",
        label: "⚠ offline scoring", sub: "network may be disabled at final scoring",
        detail: {
          ...F("docs/submission_rules.md", null),
          summary: "The rules allow final scoring to run with the network disabled. This stage is designed so that costs nothing.",
          bullets: [
            "No API calls, no keys, no per-turn network traffic — the model runs locally.",
            "Weights are downloaded once at startup and then cached by Hugging Face on disk.",
            "TECHJAM_CROSS_ENCODER_DISABLE=1 falls back to the pure-stdlib rule pipeline at TechnicalScore 0.817 — a 0.007 fallback cost.",
            "Reported token usage stays 0 in both modes, since no LLM is involved.",
          ],
          why: "The honest risk statement: first-run startup needs network for the download. Everything after that, including all scoring, is local.",
        },
      },
    ],
    edges: [
      { from: "in", to: "gate", fromSide: "bottom", toSide: "top" },
      { from: "gate", to: "topn", fromSide: "bottom", toSide: "top", label: "yes" },
      { from: "gate", to: "out", fromSide: "right", toSide: "right", label: "no → unchanged", kind: "dashed", midX: 1395 },
      { from: "query", to: "predict", fromSide: "bottom", toSide: "left", label: "query" },
      { from: "prod", to: "predict", fromSide: "bottom", toSide: "right", label: "passage" },
      { from: "topn", to: "predict", fromSide: "bottom", toSide: "top", label: "15 pairs" },
      { from: "predict", to: "blend", fromSide: "bottom", toSide: "top", label: "logits" },
      { from: "blend", to: "out", fromSide: "bottom", toSide: "top" },
      { from: "blend", to: "sweep", fromSide: "right", toSide: "left", kind: "dashed", label: "tuned by" },
      { from: "gate", to: "offline", fromSide: "left", toSide: "top", kind: "dashed" },
    ],
  },

  /* ======================= LEVEL 2 — QUESTIONS =========================== */
  questions: {
    title: "choose_question_attribute()",
    subtitle: "starter/components/questions.py — the only lever on what the customer tells us next",
    parent: "pipeline",
    w: 1420, h: 1000,
    nodes: [
      {
        id: "in", x: 520, y: 40, w: 380, h: 90, kind: "data",
        label: "SessionState + turn", sub: "disclosed · asked · unconstrained · last_asked",
        detail: {
          ...F("starter/components/questions.py", "25"),
          summary: "Pure function of state and turn number. No candidate-pool inspection — which is precisely the biggest known limitation of this module.",
        },
      },
      {
        id: "excluded", x: 520, y: 170, w: 380, h: 120, kind: "stage",
        label: "build the excluded set", sub: "disclosed ∪ unconstrained ∪ asked ∪ {last_asked}",
        detail: {
          ...F("starter/components/questions.py", "26–28"),
          summary: "Four sources of 'do not ask this'. Every one of them exists to avoid a wasted turn, since a repeat ask returns 'I don't have an additional preference for X'.",
          code: {
            lang: "python",
            text:
`excluded = state.disclosed_attributes | state.unconstrained_attributes | state.asked_attributes
if state.last_asked_attribute:
    excluded = excluded | {state.last_asked_attribute}`,
          },
          bullets: [
            "asked_attributes already contains last_asked_attribute, so the second clause only ever re-adds something already present — a genuine no-op, listed as such in the open items.",
            "It is harmless, and kept documented rather than quietly deleted.",
          ],
          why: "Worth showing as-is: a known dead branch that is honestly recorded beats a tidy diagram that hides it.",
        },
      },
      {
        id: "ovr", x: 60, y: 330, w: 400, h: 150, kind: "stage",
        label: "post-override follow-up", sub: "ask directly about the replaced attribute",
        detail: {
          ...F("starter/components/questions.py", "30–33"),
          summary: "Highest priority branch. Immediately after an override, the most valuable question is about the attribute the customer just changed, since their reply is usually a bare value and the full detail is still unknown.",
          code: {
            lang: "python",
            text:
`if state.parsed_messages and state.parsed_messages[-1].override:
    for constraint in state.parsed_messages[-1].constraints:
        if constraint.attribute not in excluded and constraint.attribute != "category":
            return constraint.attribute`,
          },
          why: "This works only because _apply_override deliberately removed that attribute from disclosed_attributes — the two modules were designed together.",
        },
      },
      {
        id: "priority", x: 520, y: 330, w: 380, h: 190, kind: "stage",
        label: "pick a priority list", sub: "buying-opener · empty-intent · active-intent",
        detail: {
          ...F("starter/components/questions.py", "9–10, 38–42"),
          summary: "Three orderings, chosen by what we know so far. All of them lead with 'feature', because that is the bucket classify_constraint assigns most clues to.",
          code: {
            lang: "python",
            text:
`EMPTY_INTENT_PRIORITY  = ("feature", "category", "use_case", "material", "color",
                          "size", "style", "brand", "budget", "other")
ACTIVE_INTENT_PRIORITY = ("feature", "material", "color", "size", "style",
                          "brand", "budget", "use_case", "category", "other")

# buying opener already leaked a hard constraint -> skip category, promote "other"
if state.messages and "key requirement is" in str(state.messages[0]).lower():
    priorities = ("feature", "material", "color", "other", "size",
                  "style", "brand", "budget", "use_case", "category")`,
          },
          bullets: [
            "Detecting 'key requirement is' identifies a buying session from the text alone — scenario_type is never passed to the agent.",
            "In that case category is demoted to last, because the opener already stated it.",
            "Rewriting these lists took TechnicalScore 0.660 → 0.757, mostly on buying (Hit 0.738 → 0.950). It is the single largest gain in the project.",
          ],
          constants: [["buying Hit before", "0.738"], ["buying Hit after", "0.950"], ["TechScore delta", "+0.097"]],
        },
      },
      {
        id: "late", x: 960, y: 330, w: 400, h: 150, kind: "stage",
        label: "late-turn escalation", sub: "turn ≥ 5 prefer 'other' · turn ≥ 7 force it",
        detail: {
          ...F("starter/components/questions.py", "35–43"),
          summary: "Specific attributes have diminishing returns; 'other' matches any remaining clue in the simulator. Late in a session, breadth beats precision.",
          code: {
            lang: "python",
            text:
`if turn >= 7 and "other" not in excluded:
    return "other"
...
elif turn >= 5 and "other" not in excluded:
    priorities = ("other", *priorities)`,
          },
          bullets: [
            "Recall from the simulator: attribute == 'other' bypasses the classify_constraint filter entirely.",
            "Added in commit c658e74; contributed to an aggregate MTTC drop from 3.69 to 3.00 turns.",
          ],
        },
      },
      {
        id: "pick", x: 520, y: 560, w: 380, h: 110, kind: "stage",
        label: "first non-excluded attribute", sub: "or None if everything is exhausted",
        detail: {
          ...F("starter/components/questions.py", "44–47"),
          summary: "A linear scan. Returning None is a real outcome, and a costly one — the simulator replies with a non-answer that burns the turn.",
          code: {
            lang: "python",
            text:
`for attribute in priorities:
    if attribute not in excluded:
        return attribute
return None`,
          },
        },
      },
      {
        id: "out", x: 520, y: 710, w: 380, h: 110, kind: "out",
        label: "ask_attribute + message", sub: "QUESTION_TEXT lookup",
        detail: {
          ...F("starter/components/questions.py", "11–22, 50–53"),
          summary: "The customer-facing text is a static lookup. Only ask_attribute is machine-read by the simulator, so the prose costs nothing to keep simple.",
          code: {
            lang: "python",
            text:
`QUESTION_TEXT = {
    "feature":  "What feature matters most to you?",
    "material": "Do you have a material preference?",
    "color":    "Do you have a preferred color?",
    "other":    "Is there another requirement I should consider?",
    ...
}
def question_text(attribute):
    if attribute is None:
        return "Here are the closest matches I found."
    return QUESTION_TEXT.get(attribute, QUESTION_TEXT["other"])`,
          },
          bullets: [
            "The simulator never reads 'message', only 'ask_attribute' — so effort went into targeting, not phrasing.",
            "A real product would generate this text; here it would be spend with no measurable return.",
          ],
        },
      },
      {
        id: "gap", x: 60, y: 580, w: 400, h: 175, kind: "warn",
        label: "⚠ the biggest open gap", sub: "static lists, not information gain",
        detail: {
          ...F("README.md", "limitations"),
          summary: "The policy is fixed priority order. It never looks at the candidate pool, so it cannot ask the question that would best split the products currently in contention.",
          bullets: [
            "The principled version: for each askable attribute, compute how evenly its values partition the current pool, and ask the one with the highest expected information gain.",
            "Everything needed is already in hand — the pool, the products dict, and the attribute extractors.",
            "Expected payoff is MTTC (and therefore Efficiency, 20% of the score), where the agent currently sits at 3.00 turns.",
            "Not attempted yet: the two static-list rewrites were already worth +0.097 and +0.006, and time went to ranking instead.",
          ],
          why: "The honest framing for a judge: this is the clearest remaining headroom in the whole system, and we can say precisely what we would build next and why.",
        },
      },
    ],
    edges: [
      { from: "in", to: "excluded", fromSide: "bottom", toSide: "top" },
      { from: "excluded", to: "ovr", fromSide: "left", toSide: "top", label: "override turn?" },
      { from: "excluded", to: "priority", fromSide: "bottom", toSide: "top" },
      { from: "excluded", to: "late", fromSide: "right", toSide: "top", label: "turn ≥ 7" },
      { from: "ovr", to: "out", fromSide: "right", toSide: "left", kind: "dashed", label: "direct return", midX: 478 },
      { from: "late", to: "out", fromSide: "bottom", toSide: "right", kind: "dashed", label: "'other'" },
      { from: "priority", to: "pick", fromSide: "bottom", toSide: "top" },
      { from: "pick", to: "out", fromSide: "bottom", toSide: "top" },
      { from: "out", to: "gap", fromSide: "left", toSide: "right", kind: "dashed" },
    ],
  },
};

/* =============================================================================
   TRACE — an animated walk of one real buying session
   ========================================================================== */

const TRACE = {
  title: "Buying session · target: a men's cotton t-shirt",
  steps: [
    {
      graph: "pipeline", node: "in_msg", label: "Turn 1 — the opener",
      text: "The simulator leaks one hard constraint immediately. Note that it is quoting the target product's own details dict.",
      code: `"I'm looking for Men's T-Shirts. A key requirement is: fabric type: 100% cotton."`,
    },
    {
      graph: "pipeline", node: "parse", label: "parse_message()",
      text: "The closed vocabulary catches 'cotton'. It does not catch 'fabric type' or '100%' — that loss is exactly why the raw text is kept as well.",
      code: `constraints = [Constraint("material", "cotton", "positive", 1.0)]
override = False   boundary = False   generic_feedback = False`,
    },
    {
      graph: "pipeline", node: "store", label: "SessionStore.update()",
      text: "Constraint folded in, attribute marked disclosed, and the category hint latched from the opener.",
      code: `positive_constraints = {"material": [cotton]}
disclosed_attributes = {"material"}
category_hint        = "men's t-shirts"`,
    },
    {
      graph: "pipeline", node: "plan", label: "build_search_plan()",
      text: "Boilerplate is stripped, leaving the verbatim clue. This snippet is a literal substring of the target's details field.",
      code: `exact_phrases = ["fabric type 100% cotton"]
snippet_terms = ["fabric", "type", "100", "cotton"]
required_terms = ["cotton"]`,
    },
    {
      graph: "pipeline", node: "retrieve", label: "get_candidates()",
      text: "Path A ANDs the rarest words of the clue; Path C ANDs it with the category; Path D adds breadth. 150 candidates survive the tiered cutoff.",
      code: `Path A:  "fabric" AND "type" AND "100" AND "cotton"
Path C:  ("men" OR "shirts") AND ("fabric" OR "100" OR "cotton")
pool  :  150 candidates, core/rare_and tiers first`,
    },
    {
      graph: "pipeline", node: "rank", label: "rerank()",
      text: "The clue matches the target's details field verbatim: +2.5 phrase, +6.0 full coverage. Generic cotton tees match the token but not the phrase.",
      code: `target      : phrase +2.5  coverage +6.0  attribute +2.5  → rank 3
generic tee : phrase +0.0  coverage +1.5  attribute +2.5  → rank 1`,
    },
    {
      graph: "pipeline", node: "cross", label: "cross-encoder rescore",
      text: "The top 15 are re-read jointly with the query. The target's full detail line reads as a much better answer than a bare 'cotton t-shirt' title.",
      code: `query   : "men's t-shirts fabric type 100% cotton"
target  : rule 11.3 + 2.0 x 4.1 = 19.5   → rank 1
generic : rule 12.1 + 2.0 x 0.9 = 13.9   → rank 2`,
    },
    {
      graph: "pipeline", node: "question", label: "choose_question_attribute()",
      text: "'material' is disclosed, so the buying-opener priority list leads with 'feature' — the bucket most of the remaining clues fall into.",
      code: `excluded   = {"material"}
priorities = ("feature", "material", "color", "other", ...)
→ ask_attribute = "feature"`,
    },
    {
      graph: "pipeline", node: "response", label: "the response",
      text: "Target at rank 1 on turn 1: this session scores hit = True, reciprocal_rank = 1.0, first_hit_turn = 1. The evaluator ends the session here.",
      code: `{"message": "What feature matters most to you?",
 "ask_attribute": "feature",
 "recommendations": [{"parent_asin": "<target>"}, ...9 more],
 "usage": {"prompt_tokens": 0, "completion_tokens": 0}}`,
    },
  ],
};

/* =============================================================================
   DOC VIEWS
   ========================================================================== */

const RESULTS = {
  headline: {
    hit: 0.965, mrr: 0.605571, mttc: 2.995, efficiency: 0.8005, ts: 0.824271, n: 200,
  },
  scenarios: [
    { name: "buying", n: 80, hit: 0.95, mrr: 0.569435, mttc: 2.5, note: "Opener leaks a hard constraint, so the first pool is already strong — the fastest scenario." },
    { name: "browsing", n: 80, hit: 0.975, mrr: 0.58811, mttc: 2.975, note: "Starts vague; recovers in one or two turns once a clue is disclosed." },
    { name: "intent_override", n: 30, hit: 0.966667, mrr: 0.765278, mttc: 4.1, note: "Highest MRR of all four. MTTC is floored near 3 by the evaluator's override gate." },
    { name: "boundary", n: 10, hit: 1.0, mrr: 0.555238, mttc: 3.8, note: "Perfect hit rate: the correct response to 'use your judgment' is to stop constraining." },
  ],
  progression: [
    { label: "Weak BM25 baseline (kit)", ts: 0.107, hit: 0.125, mrr: 0.068, mttc: 9.81, note: "Shipped reference." },
    { label: "Pipeline, pre-tuning", ts: 0.348, hit: 0.45, mrr: 0.191, mttc: 7.71, note: "Five stages wired, nothing tuned." },
    { label: "+ retrieval on verbatim text", ts: 0.66, hit: 0.79, mrr: 0.458, mttc: 4.64, note: "Raw customer text into retrieval." },
    { label: "+ question-policy rewrite", ts: 0.757, hit: 0.915, mrr: 0.552, mttc: 4.31, note: "Largest single gain (+0.097); buying Hit 0.738 → 0.950." },
    { label: "+ surgical override handling", ts: 0.766, hit: 0.92, mrr: 0.561, mttc: 4.11, note: "Replace one attribute, not all." },
    { label: "+ tiered pool cutoff", ts: 0.772, hit: 0.93, mrr: 0.56, mttc: 4.055, note: "Stop comparing BM25 across query shapes." },
    { label: "+ snippets into rerank", ts: 0.79, hit: 0.945, mrr: 0.572, mttc: 3.69, note: "Rank on the text that retrieved." },
    { label: "+ pre-override retention, turn-aware asks", ts: 0.817, hit: 0.965, mrr: 0.583, mttc: 3.0, note: "Closed intent_override; MTTC −0.69 turns." },
    { label: "+ cross-encoder second stage", ts: 0.824, hit: 0.965, mrr: 0.605571, mttc: 2.995, note: "Current. Ordering only — Hit@10 unchanged." },
  ],
  facts: [
    ["Public set", "200 sessions · 80 buying / 80 browsing / 30 intent_override / 10 boundary"],
    ["Full run time", "~33 s rule-only; the cross-encoder adds roughly 5–15× on CPU"],
    ["Startup", "~40 s (two catalog passes + FTS5 build), uncached"],
    ["LLM tokens", "0 — no API calls anywhere in the pipeline"],
    ["Dependencies", "stdlib only, plus sentence-transformers for the second stage"],
    ["Determinism", "Byte-identical reruns; sorting tiebreaks on parent_asin"],
  ],
  open: [
    { title: "Question policy is static", body: "Attributes come from fixed priority lists, not from what would best split the current candidate pool. An information-gain selector is the clearest remaining MTTC win, and everything it needs is already in memory." },
    { title: "buying MRR is the weakest scenario number", body: "0.569 against Hit@10 0.950 — targets are found but land mid-list. Aggregate MRR (0.606) is the main headroom now that Hit@10 is near its ceiling." },
    { title: "Cross-encoder generalisation unverified", body: "top_n and weight were tuned on a 50-session public quick sweep. The 800-session private split may behave differently; all nine sweep configurations beat the baseline, which is mildly reassuring." },
    { title: "Two untuned scoring terms", body: "_quality_tiebreak and the raw carried retrieval_score have never been sensitivity-checked against the much larger snippet signals. Cheap experiment, not yet run." },
    { title: "Index build is uncached", body: "CandidateIndex.__init__ rebuilds the FTS5 table and df Counter on every startup (~40 s). Persisting them would speed up both iteration and cold starts." },
    { title: "No true semantic retrieval", body: "Recall is entirely lexical. A paraphrase sharing no tokens with the catalog row is only caught if the candidate already made the pool and the cross-encoder can reorder it." },
  ],
};

const SCENARIOS = [
  {
    name: "Buying", share: "40% · 80 sessions", tone: "buy",
    hit: "0.950", mrr: "0.569", mttc: "2.50",
    idea: "A hard constraint is disclosed in the opener.",
    transcript: [
      ["customer", "I'm looking for Men's T-Shirts. A key requirement is: fabric type: 100% cotton."],
      ["agent", "What feature matters most to you? — Top 10 already contains the target at rank 1"],
    ],
    handling: [
      "questions.py detects the literal string 'key requirement is' in turn 1 and switches to the buying priority list, demoting 'category' (already stated) and promoting 'other'.",
      "The disclosed constraint is a verbatim fragment of the target's details dict, so Path A's rare-term AND often isolates it on turn 1.",
      "Fastest scenario at 2.50 turns to first hit.",
    ],
    weak: "MRR 0.569 is the lowest of the four: the target is nearly always in the Top 10, but a strong lexical clue is shared by many near-identical products, so it often lands mid-list.",
  },
  {
    name: "Browsing", share: "40% · 80 sessions", tone: "browse",
    hit: "0.975", mrr: "0.588", mttc: "2.98",
    idea: "Starts deliberately vague — no constraint at all in turn 1.",
    transcript: [
      ["customer", "I'm looking for Women's Running Shoes, but I'm still exploring."],
      ["agent", "What feature matters most to you?"],
      ["customer", "For that, what matters is: breathable mesh upper; removable insole."],
      ["agent", "Do you have a material preference? — target now in Top 10"],
    ],
    handling: [
      "Turn 1 has no payload: the snippet extractor drops the opener entirely and only category_hint survives.",
      "Candidate-pool recall on turn-1-only information is 0.46 for browsing, versus 0.81 for buying — the gap is real and expected.",
      "Recovery is fast because the first disclosure is usually two clues at once ('; '-joined), which Path A and Path C can both exploit.",
    ],
    weak: "Highest hit rate of the three main scenarios (0.975) — vagueness costs a turn, not the session.",
  },
  {
    name: "Intent Override", share: "15% · 30 sessions", tone: "override",
    hit: "0.967", mrr: "0.765", mttc: "4.10",
    idea: "On turn 3 or 4 the customer retracts a stated preference and replaces it.",
    transcript: [
      ["customer", "I'm looking for Men's Jackets. I prefer a lightweight shell."],
      ["agent", "Do you have a material preference?"],
      ["customer", "For that, what matters is: polyester."],
      ["agent", "What feature matters most to you?"],
      ["customer", "Actually, ignore my earlier preference. What I need is: 100% cotton twill."],
      ["agent", "Do you have a material preference? — re-asking the replaced attribute"],
    ],
    handling: [
      "parser flags the turn via OVERRIDE_PHRASES; _apply_override clears only 'material', demotes 'polyester' to a negative constraint (−4.0 in a title), and re-opens the attribute for questioning.",
      "snippets.py keeps pre-override clues at weight 0.35 instead of discarding them — the customer replaced one preference, not the whole request.",
      "rerank applies a 1.5× _override_boost to the freshest phrases.",
      "questions.py immediately asks about the replaced attribute, because the override reply is usually a bare value.",
    ],
    weak: "Now the highest MRR of all four scenarios (0.765). MTTC 4.10 is close to its floor: the evaluator's override_applied gate refuses to count any hit before turn 3.",
  },
  {
    name: "Boundary", share: "5% · 10 sessions", tone: "boundary",
    hit: "1.000", mrr: "0.555", mttc: "3.80",
    idea: "The customer explicitly declines to constrain an attribute we asked about.",
    transcript: [
      ["customer", "I'm looking for Men's Socks, but I'm still exploring."],
      ["agent", "What feature matters most to you?"],
      ["customer", "I don't have a preference for feature; please use your judgment."],
      ["agent", "Do you have a material preference? — 'feature' is now off the table for good"],
    ],
    handling: [
      "parser sets boundary via BOUNDARY_PHRASES; SessionStore adds the attribute to unconstrained_attributes.",
      "search_plan skips it, rerank skips its attribute score and mismatch penalty, questions.py never asks again.",
      "snippets.py drops the turn through NON_ANSWER_RE, so no noise tokens reach retrieval.",
    ],
    weak: "Hit@10 1.000, but only 10 sessions — every metric here is noise-dominated, and one rank change moves MRR by 0.05. Worth stating plainly rather than claiming a win.",
  },
];

const TEAM = {
  members: [
    {
      name: "Rayson Yap", area: "Stateful conversation model",
      files: ["session_store.py", "questions.py", "models.py (SessionState)"],
      body: "Built the multi-turn SessionState fold, including the Intent Override and Boundary transitions, and the clarification-attribute policy that drives what the simulated customer discloses.",
    },
    {
      name: "Puah Tze Foong", area: "Retrieval",
      files: ["retrieval.py", "snippets.py", "search_plan.py"],
      body: "Built the in-memory FTS5 BM25 index, the document-frequency rare-term selection, and the specificity-ranked union of retrieval paths that produces the candidate pool from verbatim customer text.",
    },
    {
      name: "Brian Chan", area: "Ranking",
      files: ["rerank.py", "cross_encoder_rerank.py"],
      body: "Built the additive deterministic scoring model — exact-phrase and snippet-coverage bonuses, per-attribute containment, budget and mismatch penalties, feedback demotion — and the cross-encoder second stage.",
    },
  ],
  shared: "parser.py and agent.py wiring were shared work. tests/ covers the parser, search plan, session store, questions, rerank and the evaluator itself.",
  principles: [
    ["Recall and precision must agree on the query", "Retrieval searched raw customer text while ranking scored thin parser output. Making both read components/snippets.py was worth +0.018 TechnicalScore on its own."],
    ["Read the counterpart, do not model it", "The simulated customer is deterministic and its source is public. Phrase lists that match its exact wording are not a hack — they are the correct tool."],
    ["Measure one thing at a time", "Every score in the progression table is a single change against a byte-identical rerun. Nothing here is a bundled guess."],
    ["Keep the failure modes visible", "The no-op guard in questions.py, the boundary MRR dip, the unverified sweep — all documented in-repo rather than smoothed over."],
    ["Earn the dependency", "One learned component, added last, worth +0.007, with a documented offline fallback. Everything else is the standard library."],
  ],
};
