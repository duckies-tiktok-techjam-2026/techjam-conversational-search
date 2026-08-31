"""Verbatim disclosure text, shared by retrieval and rerank.

The parser only keeps tokens from its fixed vocab lists, so the discriminative
part of a disclosure ("4.3 oz", "jersey knit", "tagless") never reaches
``positive_constraints``. Both the candidate index (which ANDs rare terms) and
the reranker (which phrase-matches against product fields) need the raw customer
text instead, and they need *the same* text: ranking on a thinner query than the
one that found the product is what buries correct hits mid-list.

The simulated customer echoes the target product's own ``features`` /
``details`` strings back at us ("For that, what matters is: fabric type: 100%
cotton"), so a snippet is often a verbatim substring of the target's catalog
row -- the strongest ranking signal available.
"""

from __future__ import annotations

import re

TOKEN_RE = re.compile(r"[a-z0-9]+")
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
    "it", "of", "on", "or", "the", "to", "with", "your", "you", "this", "that",
    "made", "quality", "great", "high", "will", "can", "size", "fit",
    # Conversational scaffolding. These describe the *act of asking*, never a
    # product attribute, so they must not survive into the ranking query -- a
    # low-df word like "matters" is otherwise a prime pick for the rare-term AND
    # in retrieval, which then matches almost nothing.
    "i", "im", "me", "my", "am", "we", "us", "please", "thanks", "hi", "hello",
    "looking", "look", "want", "need", "needs", "prefer", "preference", "like",
    "what", "matters", "matter", "mainly", "mostly", "really", "actually",
    "requirement", "key", "must", "should", "would", "there", "here", "these",
    "those", "them", "something", "anything", "some", "any", "but", "still",
    "yet", "more", "additional", "else", "one", "specific", "attribute",
    "options", "option", "ask", "tell", "think", "know", "find", "get",
}

# Turns that carry no product information: boundary answers, "nothing more for
# that attribute" non-answers, and generic negative feedback.
# The first four alternatives are the simulator's current wordings; the rest cover
# the same *intent* in other phrasings, because a missed non-answer is expensive --
# the turn's filler tokens enter the ranking query as if they were a disclosure.
NON_ANSWER_RE = re.compile(
    r"(?:do not|don't|dont) have (?:an?|any)\b[^.]*preference"
    r"|no preference"
    r"|use your judgment"
    r"|not quite right"
    r"|no (?:strong )?(?:feelings|opinion|views)"
    r"|not (?:fussy|picky|bothered)"
    r"|(?:nothing|no more|not much) (?:else|further|more)\b"
    r"|that'?s all i (?:have|can say|know)"
    r"|either (?:one )?is fine|whatever you think|up to you|your call"
    r"|(?:isn'?t|aren'?t|not) what i'?m (?:after|looking for)"
    r"|doesn'?t matter|does not matter|don'?t mind|do not mind"
    # A browsing opener carries only the category, which is extracted separately;
    # everything else in it is filler that must not enter the ranking query.
    r"|still exploring|just (?:browsing|looking)|not sure (?:exactly|yet)"
)
# "i'm looking for men's t-shirts, but i'm still exploring." -> the category is
# handled separately; the rest of the opener is filler. One lead-in pattern feeds
# both the strip and the capture, so a change to how the customer opens a session
# is a single edit -- session_store and retrieval both read the category through
# category_from_opener.
_OPENER_LEAD = r"(?:hi,?\s*)?(?:i'?m |i am |i )?(?:looking for|shopping for|want to find|need|want)\s+"
OPENER_RE = re.compile(rf"^{_OPENER_LEAD}.*?[,.]\s*")
CATEGORY_OPENER_RE = re.compile(rf"{_OPENER_LEAD}(.+?)[,.]", re.IGNORECASE)
# Last resort when no opener verb is recognised: the customer names the category
# in their first clause regardless of how they introduce it.
FIRST_CLAUSE_RE = re.compile(r"^[^,.;:]{3,60}[,.;:]")
SNIPPET_SPLIT_RE = re.compile(r";|(?<=\.)\s+")
# Pre-override clues stay in the pool but rank below post-override text.
_PRE_OVERRIDE_WEIGHT = 0.35


def tokens(text: str) -> list[str]:
    return [
        token
        for token in TOKEN_RE.findall(str(text).lower())
        if len(token) > 1 and token not in STOPWORDS
    ]


def category_from_opener(text: object) -> str:
    """The category the customer named in their opening message, or ``""``."""
    lowered = str(text or "").lower()
    match = CATEGORY_OPENER_RE.search(lowered)
    if match:
        return match.group(1).strip()
    clause = FIRST_CLAUSE_RE.match(lowered)
    return clause.group(0).strip(" .,;:") if clause else ""


def _strip_lead_in(text: str) -> str:
    """Remove an opening category clause, but never the whole message.

    A single-sentence opener ("i need boots -- it has to be black leather") has
    its only punctuation at the end, so an unguarded strip deletes the disclosure
    along with the lead-in.
    """
    for pattern in (OPENER_RE, FIRST_CLAUSE_RE):
        stripped = pattern.sub("", text, count=1)
        if stripped != text and tokens(stripped):
            return stripped
    return text


def _override_start_index(parsed_messages) -> int | None:
    for index, parsed in enumerate(parsed_messages):
        if parsed.override:
            return index
    return None


def disclosure_snippet_entries(state) -> list[tuple[str, int]]:
    """Return ``(snippet, source_message_index)`` pairs in disclosure order."""
    parsed_messages = getattr(state, "parsed_messages", None) or []
    entries: list[tuple[str, int]] = []
    for index, parsed in enumerate(parsed_messages):
        text = str(parsed.normalized_text or "")
        if not text or NON_ANSWER_RE.search(text):
            continue
        if ":" in text:
            payload = text.split(":", 1)[1]
        else:
            # No lead-in colon. Drop the opening clause -- it names the category,
            # which is carried separately -- but only if something survives. Turn 0
            # used to be discarded wholesale here, which silently threw away the
            # entire turn-1 disclosure whenever it was phrased without a colon.
            payload = _strip_lead_in(text) if index == 0 else OPENER_RE.sub("", text)
        for part in SNIPPET_SPLIT_RE.split(payload):
            part = part.strip(" .,-")
            if tokens(part):
                entries.append((part, index))
    return entries


def disclosure_snippets(state) -> list[str]:
    """Verbatim constraint text the customer actually said, newest turns last."""
    seen: dict[str, float] = {}
    override_start = _override_start_index(getattr(state, "parsed_messages", None) or [])
    for snippet, message_index in disclosure_snippet_entries(state):
        weight = 1.0 if override_start is None or message_index >= override_start else _PRE_OVERRIDE_WEIGHT
        if snippet not in seen:
            seen[snippet] = weight
        else:
            seen[snippet] = max(seen[snippet], weight)
    return list(seen.keys())


def snippet_weights(state, snippets: list[str]) -> list[float]:
    """Parallel weights for ``disclosure_snippets`` output (higher = fresher intent)."""
    override_start = _override_start_index(getattr(state, "parsed_messages", None) or [])
    index_by_snippet = {
        snippet: message_index
        for snippet, message_index in disclosure_snippet_entries(state)
    }
    weights: list[float] = []
    for snippet in snippets:
        message_index = index_by_snippet.get(snippet, 0)
        if override_start is None or message_index >= override_start:
            weights.append(1.0)
        else:
            weights.append(_PRE_OVERRIDE_WEIGHT)
    return weights


def snippet_terms(snippets: list[str]) -> list[str]:
    """Flat, de-duplicated token set behind ``snippets`` -- the ranking query."""
    return list(dict.fromkeys(token for snippet in snippets for token in tokens(snippet)))
