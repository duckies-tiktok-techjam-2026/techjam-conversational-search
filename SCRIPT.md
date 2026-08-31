# Pipeline Walkthrough — Presentation Script

---

## Slide 1 — Full Pipeline Overview

Every customer message goes through the same loop: we parse the turn into a structured query, retrieve about 150 candidates out of the 50,000-product catalog, and rank that down to a top 10. If we're not confident yet, we ask one clarification question and loop back — up to 10 turns per session.

The thing worth pointing out here is that dotted box: parsing, retrieval, and ranking are all deterministic and run in a single pass — no LLM anywhere in that loop. The clarification question is really the steering wheel of the whole conversation, since it decides what we get to learn on the next turn.

**Transition:** "Let's open up that first box — parsing the turn."

---

## Slide 2 — Parse the Turn (overview)

Parsing the turn is three deterministic passes that turn one free-text message into something the rest of the system can act on: parse the message into constraints, fold that into one running state for the session, then build a search plan that retrieval and ranking both read from. Same input, same output, every time.

**Transition:** "Let's go through each of those three."

---

## Slide 3 — Step 1: Parse Message

This turns one message into a list of constraints — attribute, value, and whether it's a positive or negative constraint — plus three flags for things like a change of mind or a waived preference. It runs off word lists for material, colour, size, and so on.

Worth noting: anything outside those word lists just gets dropped. That's a real limitation, and we treat it as one rather than pretending the parser understands more than it does.

**Transition:** "Those constraints have to live somewhere across the whole session — that's the session store."

---

## Slide 4 — Step 2: Session Store

One state object per session — everything the shopper has told us, everything we've already asked, everything they've waived.

The one thing worth calling out: our first version used to wipe the whole state whenever someone changed their mind, which threw away several turns of still-valid clues just to honor one correction. Once we changed it to only clear the specific attribute being replaced, our intent-override scenario jumped from 0.833 to 0.967 Hit Rate. So that one fix mattered a lot.

**Transition:** "With state tracked, the last parsing step turns that into an actual search plan."

---

## Slide 5 — Step 3: Build Search Plan

This builds the query object that retrieval and ranking both read from — required, optional, and excluded terms, plus the shopper's own sentences kept word for word.

The important design decision here: the exact same raw sentences go to both retrieval and ranking, not a thinned-out version. Feeding raw sentences to retrieval lifted pool recall from 0.860 to 0.985, and feeding that same text to the ranker was worth another 0.018 on the final score.

**Transition:** "That's the whole parsing stage. Now let's follow that search plan into retrieval."

---

## Slide 6 — Retrieve Candidates

This cuts the 50,000-product catalog down to about 150 candidates, using four search paths in parallel — rare terms, every clue combined, category, and attributes — merged into one pool.

Worth explaining: that merge is cut by evidence tier, not raw BM25 score, because scores from a broad query and a strict multi-clause query aren't comparable — treating them as if they were would push genuine matches out of the pool. This stage matters more than it looks, because if the target isn't in this pool of 150, the turn is lost no matter how good ranking is afterward — retrieval is really the ceiling on our whole score.

**Transition:** "So that's 50,000 products down to 150. Now let's see how those 150 become the final top 10 — ranking and return."

---

## Slide 7 — Rank & Return (overview)

This stage takes the ~150 candidates and decides the order, which matters a lot since the score cares whether the right product lands 1st or 8th. Three steps: a rule-based rerank over all 150, a cross-encoder that re-reads just the top 15, and finally assembling the response.

**Transition:** "Starting with the rule-based rerank."

---

## Slide 8 — Step 5: Rule-Based Rerank

One hand-written score per candidate — seven signals add points, four penalties take them away, and the total decides the order. It rewards exact matches and word overlap weighted by where they land, and penalizes things like showing an excluded term or going over budget.

It's all fully transparent — nothing here is learned, so any regression traces back to one number we can read and fix directly.

**Transition:** "That gives us a ranked shortlist. Next, we hand the top of it to a small model for one more pass."

---

## Slide 9 — Step 6: Cross-Encoder Rerank

A small pretrained ranking model re-reads just the top 15 with the query and product side by side, and nudges the order — nothing below the top 15 is touched.

It's a small gain on paper, about +0.007 on the final score, but it's the one stage that can improve the very top of the list without risking the bottom of it — and it helps most specifically on intent-override sessions.

**Transition:** "Last step in this stage — actually assembling what we send back."

---

## Slide 10 — Step 7: Top 10 + Response

This packages everything up — the first 10 valid catalog IDs in order, a message, and the attribute we want answered next. No language model runs here, so token usage is always zero. Everything upstream exists just to fill these ten slots in the right order.

**Transition:** "So that's retrieval and ranking end to end. But there's one more piece that decides what happens on the *next* turn — the clarification question."

---

## Slide 11 — Clarification Question

When we're not confident enough, this decides the single attribute to ask about next — and since the shopper only answers the thing we actually ask about, this one choice decides everything we learn on the following turn. It avoids re-asking anything already answered or waived, defaults to "feature" first since that's the biggest open bucket, skips category for buying sessions that already stated one, and falls back to a catch-all once we're running low on turns.

This is genuinely the single biggest lever in the whole project — rewriting this policy alone added **+0.097** to our score, more than any change we made to retrieval or ranking, and it costs nothing at runtime since there's no model involved.

**Transition:** "So let's pull that all together."

---

## Conclusion

The whole agent is one deterministic loop: parse the turn, retrieve about 150 candidates out of 50,000, rank them down to a top 10, and if we're not confident, ask exactly one targeted question and repeat. Nothing in that loop touches an LLM — every piece is fast, explainable, and runs offline.

The two biggest wins in the whole project came from two very different places: keeping the full raw sentences flowing into both retrieval and ranking, and getting the clarification policy right so every question we ask actually earns its turn. That combination is what took us from a 0.125 baseline Hit Rate to a 0.790 Hit@10 with a 0.660 TechnicalScore.