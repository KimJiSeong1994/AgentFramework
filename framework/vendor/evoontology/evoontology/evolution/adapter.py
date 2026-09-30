"""Minimal evaluation-adapter contract for evolution runs.

An adapter knows how to run one benchmark or user scenario against a given
semantic version and report comparable results. EvolutionSession consumes only
the normalized result dict; it never touches benchmark internals.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class EvolutionAdapter(Protocol):
    """Evaluate one semantic version and return a comparable result."""

    def evaluate(
        self,
        subject: str,
        cases: Optional[List[str]] = None,
        output_hint: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run the evaluation for ``subject`` (a semantic version name).

        ``cases`` optionally restricts the evaluation to a subset of cases.
        ``output_hint`` suggests where artifacts may be written; adapters keep
        their own default output layout when it is omitted.

        Returns at least::

            {
                "metrics": {...},
                "cases": [{"id": ..., "score": ..., "status": ...}],
                "artifact_paths": [...],
            }

        Only ``metrics`` is required for a gate decision; per-case results and
        artifact paths strengthen diagnosis but stay optional.
        """
        ...


def normalize_result(result: Any) -> Dict[str, Any]:
    """Validate an adapter result and fill the two optional list fields."""
    if not isinstance(result, dict):
        raise ValueError("adapter result must be a dict")
    if not isinstance(result.get("metrics"), dict):
        raise ValueError("adapter result must contain a 'metrics' dict")
    normalized = dict(result)
    for field in ("cases", "artifact_paths"):
        value = normalized.get(field)
        if value is None:
            normalized[field] = []
        elif not isinstance(value, list):
            raise ValueError(f"adapter result {field!r} must be a list")
    return normalized
