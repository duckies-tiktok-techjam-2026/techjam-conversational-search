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
}

# Turns that carry no product information: boundary answers, "nothing more for
# that attribute" non-answers, and generic negative feedback.
NON_ANSWER_RE = re.compile(
    r"(?:do not|don't|dont) have (?:an?|any)\b[^.]*preference"
    r"|no preference"
    r"|use your judgment"
    r"|not quite right"
)
# "i'm looking for men's t-shirts, but i'm still exploring." -> the category is
# handled separately; the rest of the opener is filler.
OPENER_RE = re.compile(r"^i'?m looking for .*?[,.]\s*")
SNIPPET_SPLIT_RE = re.compile(r";|(?<=\.)\s+")


def tokens(text: str) -> list[str]:
    return [
        token
        for token in TOKEN_RE.findall(str(text).lower())
        if len(token) > 1 and token not in STOPWORDS
    ]


def disclosure_snippets(state) -> list[str]:
    """Verbatim constraint text the customer actually said, newest turns last.

    Scoped to the last override onward, boilerplate stripped, split into the
    individual constraints the simulator joined with ``;``.
    """
    parsed_messages = getattr(state, "parsed_messages", None) or []
    start_index = 0
    for index, parsed in enumerate(parsed_messages):
        if parsed.override:
            start_index = index

    snippets: list[str] = []
    for index, parsed in enumerate(parsed_messages[start_index:], start=start_index):
        text = str(parsed.normalized_text or "")
        if not text or NON_ANSWER_RE.search(text):
            continue
        if ":" in text:
            payload = text.split(":", 1)[1]
        elif index == 0:
            continue
        else:
            payload = OPENER_RE.sub("", text)
        for part in SNIPPET_SPLIT_RE.split(payload):
            part = part.strip(" .,-")
            if tokens(part):
                snippets.append(part)
    return list(dict.fromkeys(snippets))


def snippet_terms(snippets: list[str]) -> list[str]:
    """Flat, de-duplicated token set behind ``snippets`` -- the ranking query."""
    return list(dict.fromkeys(token for snippet in snippets for token in tokens(snippet)))
