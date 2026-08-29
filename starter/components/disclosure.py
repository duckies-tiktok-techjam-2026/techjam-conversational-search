"""Shared verbatim disclosure snippet extraction for retrieval and rerank."""

from __future__ import annotations

import re

from .models import SessionState

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
    "it", "of", "on", "or", "the", "to", "with", "your", "you", "this", "that",
    "made", "quality", "great", "high", "will", "can", "size", "fit",
}

# Turns that carry no product information: boundary answers, "nothing more for
# that attribute" non-answers, and generic negative feedback.
_NON_ANSWER_RE = re.compile(
    r"(?:do not|don't|dont) have (?:an?|any)\b[^.]*preference"
    r"|no preference"
    r"|use your judgment"
    r"|not quite right"
)
# "i'm looking for men's t-shirts, but i'm still exploring." -> the category is
# handled separately; the rest of the opener is filler.
_OPENER_RE = re.compile(r"^i'?m looking for .*?[,.]\s*")
_SNIPPET_SPLIT_RE = re.compile(r";|(?<=\.)\s+")


def disclosure_tokens(text: str) -> list[str]:
    return [
        token
        for token in _TOKEN_RE.findall(str(text).lower())
        if len(token) > 1 and token not in _STOPWORDS
    ]


def disclosure_snippets(state: SessionState) -> list[str]:
    """Verbatim constraint text the customer actually said, newest turns last.

    The parser only keeps tokens from its fixed vocab lists, so the
    discriminative part of a disclosure ("4.3 oz", "jersey knit", "tagless")
    never reaches ``positive_constraints``. Downstream consumers read the raw
    turn text instead.
    """
    parsed_messages = getattr(state, "parsed_messages", None) or []
    start_index = 0
    for index, parsed in enumerate(parsed_messages):
        if parsed.override:
            start_index = index

    snippets: list[str] = []
    for index, parsed in enumerate(parsed_messages[start_index:], start=start_index):
        text = str(parsed.normalized_text or "")
        if not text or _NON_ANSWER_RE.search(text):
            continue
        if ":" in text:
            payload = text.split(":", 1)[1]
        elif index == 0:
            continue
        else:
            payload = _OPENER_RE.sub("", text)
        for part in _SNIPPET_SPLIT_RE.split(payload):
            part = part.strip(" .,-")
            if disclosure_tokens(part):
                snippets.append(part)
    return list(dict.fromkeys(snippets))
