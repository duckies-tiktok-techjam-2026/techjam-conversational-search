# Conversational E-Commerce Search Architecture Suggestions

## Recommended Direction

Build an offline, stateful hybrid retrieval agent:

> Session state + query rewriting + multi-field FTS5 retrieval + structured constraint reranking + adaptive clarification.

This fits the challenge because the catalog has 50,000 products, scoring requires an exact `parent_asin` in the first 10 results, and private evaluation may run without network access.

## Architecture

### 1. Catalog indexes

Build indexes once in `Agent.__init__`:

- SQLite FTS5 over title, categories, features, details, description, and store.
- Higher weights for title and categories; lower weights for description and store.
- Normalized token and phrase indexes for exact matching and synonym expansion.
- Structured metadata for price, material, color, brand, and categories.
- Product records keyed by `parent_asin`.

Generate candidates from several retrieval paths and merge them:

- Title/category BM25
- Feature/detail BM25
- Exact phrase matches
- Token overlap
- Fuzzy or normalized matches

Retrieve roughly 50-200 candidates before reranking rather than ranking the entire catalog repeatedly.

### 2. Stateful conversation model

Keep per-session state containing:

```text
user profile
positive constraints
negative constraints
query history
already disclosed attributes
current candidate IDs
```

Classify each customer message as a new requirement, preference, correction, override, boundary response, or generic dissatisfaction. Rebuild the query when requirements change instead of blindly appending every turn.

Detect override language such as `actually`, `instead`, `ignore my earlier preference`, and `changed my mind`. On an override, clear stale preferences while preserving category context.

### 3. Candidate reranking

Use deterministic scoring after retrieval:

```text
score =
    5.0 * exact title phrase match
  + 3.5 * title token overlap
  + 3.0 * category match
  + 2.5 * feature match
  + 2.0 * detail match
  + 1.5 * material/color match
  + 1.0 * description match
  - contradiction penalties
```

Hard constraints must outweigh soft preferences. Exact phrases and title matches should dominate long descriptions. Rating and review count should be tie-breakers only.

Apply contradiction penalties for explicit mismatches such as the wrong material, color, size, or budget. Always return valid, unique catalog IDs in ranked order.

## Clarification Policy

Return recommendations on every turn, including turns where a question is asked.

### Buying

The first message already exposes one hard constraint. Ask for the most useful undisclosed attribute, typically choosing dynamically among feature, material, color, style/use case, and budget.

### Browsing

The opening is vague. Ask about category or use case first, then feature, material, color, style, and budget while returning broad candidates.

### Intent override

When the replacement requirement arrives on turn 3 or 4:

1. Detect the override.
2. Remove stale preferences.
3. Rebuild retrieval using the new requirement.
4. Avoid asking about the superseded attribute again.

### Boundary

When the customer says there is no preference for an attribute, mark it unconstrained. Do not penalize products for that attribute and ask about a different one next turn.

A fixed question such as always asking about material is risky because the simulator only reveals information when `ask_attribute` matches its hidden constraint.

## Implementation Options

### Option A: Enhanced BM25

Start here. It is fast, reproducible, standard-library compatible, and low risk:

- Field-weighted FTS5
- Phrase matching
- Synonym expansion
- Stateful query rewriting
- Structured reranking

### Option B: Lexical plus local embeddings

Add an offline embedding model only after the lexical system works. Use embeddings for paraphrases and lexical constraints for exact attributes such as material, color, and price. Keep a lexical-only fallback because model packaging and startup latency add risk.

### Option C: LLM planner plus local retriever

An optional LLM can extract intent and choose the next question, but retrieval, ranking, ID validation, and fallback should remain local. Network-disabled scoring means this must never be the only path.

## Build Order

1. Replace the single BM25 query with multi-field retrieval.
2. Add session state and query rewriting.
3. Add material, color, budget, size, and use-case extraction.
4. Add override and boundary handling.
5. Add reranking and contradiction penalties.
6. Measure buying, browsing, intent-override, and boundary scenarios separately.
7. Experiment with embeddings or an optional LLM only after the offline baseline is strong.

## Main Risks

- Accumulating an old preference after an intent override.
- Asking an attribute that has already been disclosed or has no matching hidden constraint.
- Letting description matches outrank exact title or feature matches.
- Returning invalid or duplicate `parent_asin` values.
- Depending on a network API without an equivalent offline fallback.
