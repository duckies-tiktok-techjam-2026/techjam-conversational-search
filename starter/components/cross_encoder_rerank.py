"""Optional second-stage cross-encoder rerank (sentence-transformers).

Unlike bi-encoders (MiniLM cosine similarity), a cross-encoder reads the
(query, product) pair jointly, which is stronger for pushing the exact item
to rank 1. Only the top rule-scored candidates are rescored for speed.

Enable with ``TECHJAM_CROSS_ENCODER_RERANK=1`` (default off).
Without the package installed, all calls are a no-op.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

from .models import SearchPlan, SessionState

_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
# Defaults from quick sweep on the public set (top_n=15, weight=2.0).
_DEFAULT_TOP_N = 15
_DEFAULT_WEIGHT = 2.0
_ENV_FLAG = "TECHJAM_CROSS_ENCODER_RERANK"


def _top_n() -> int:
    raw = os.environ.get("TECHJAM_CROSS_ENCODER_TOP_N", str(_DEFAULT_TOP_N)).strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return _DEFAULT_TOP_N


def _cross_encoder_weight() -> float:
    raw = os.environ.get("TECHJAM_CROSS_ENCODER_WEIGHT", str(_DEFAULT_WEIGHT)).strip()
    try:
        return float(raw)
    except ValueError:
        return _DEFAULT_WEIGHT


def _enabled_by_env() -> bool:
    return os.environ.get(_ENV_FLAG, "").strip().lower() in {"1", "true", "yes", "on"}


def _as_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(f"{key} {item}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value)


def _normalize(value: object) -> str:
    return re.sub(r"\s+", " ", _as_text(value).strip())


def build_query_text(state: SessionState, plan: SearchPlan) -> str:
    parts: list[str] = []
    hint = str(getattr(state, "category_hint", "") or "").strip()
    if hint:
        parts.append(hint)
    parts.extend(plan.exact_phrases)
    parts.extend(plan.required_terms)
    return " ".join(part for part in parts if part).strip()


def build_product_text(product: Mapping[str, object]) -> str:
    return _normalize(
        " ".join(
            [
                _as_text(product.get("title")),
                _as_text(product.get("categories")),
                _as_text(product.get("features")),
                _as_text(product.get("details")),
            ]
        )
    )


class CrossEncoderReranker:
    def __init__(self) -> None:
        self._model = None
        self._load_failed = False

    @property
    def enabled(self) -> bool:
        return _enabled_by_env() and self._ensure_model()

    def _ensure_model(self) -> bool:
        if self._load_failed:
            return False
        if self._model is not None:
            return True
        try:
            from sentence_transformers import CrossEncoder
        except ImportError:
            self._load_failed = True
            return False
        try:
            self._model = CrossEncoder(_MODEL_NAME)
        except Exception:
            self._load_failed = True
            return False
        return True

    def boost_scores(
        self,
        scores: Mapping[str, float],
        state: SessionState,
        plan: SearchPlan,
        products: Mapping[str, Mapping[str, object]],
    ) -> dict[str, float]:
        if not self.enabled or not scores:
            return dict(scores)

        query = build_query_text(state, plan)
        if not query:
            return dict(scores)

        top_asins = [
            parent_asin
            for parent_asin, _score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        ][: _top_n()]

        pairs: list[list[str]] = []
        valid_asins: list[str] = []
        for parent_asin in top_asins:
            product = products.get(parent_asin)
            if not product:
                continue
            text = build_product_text(product)
            if not text:
                continue
            valid_asins.append(parent_asin)
            pairs.append([query, text])

        if not valid_asins:
            return dict(scores)

        assert self._model is not None
        cross_scores = self._model.predict(pairs)

        boosted = dict(scores)
        for parent_asin, cross_score in zip(valid_asins, cross_scores, strict=True):
            boosted[parent_asin] = boosted[parent_asin] + _cross_encoder_weight() * float(cross_score)
        return boosted
