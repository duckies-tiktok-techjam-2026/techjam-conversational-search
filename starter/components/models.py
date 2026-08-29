from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Constraint:
    attribute: str
    value: str
    polarity: str
    confidence: float


@dataclass(frozen=True)
class ParsedMessage:
    normalized_text: str
    tokens: list[str]
    constraints: list[Constraint]
    override: bool
    boundary: bool
    generic_feedback: bool


@dataclass(frozen=True)
class SearchPlan:
    required_terms: list[str]
    optional_terms: list[str]
    excluded_terms: list[str]
    exact_phrases: list[str]
    attribute_values: dict[str, list[str]]
    # Raw tokens of the verbatim disclosure snippets behind ``exact_phrases``;
    # what the parser drops on the floor. Defaulted so the empty-plan fallback in
    # rerank keeps working positionally.
    snippet_terms: list[str] = field(default_factory=list)


@dataclass
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
    last_search_plan: SearchPlan | None = None
