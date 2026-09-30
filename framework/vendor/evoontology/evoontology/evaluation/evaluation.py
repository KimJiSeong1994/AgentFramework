"""Evaluation scheduling: decide whether a Candidate beats its Parent.

Two protocols, chosen by whether ground truth exists:

- **Ground truth** — a benchmark ``score_fn(answer, gt) -> float`` gives absolute
  scores; the Candidate is accepted when its aggregate score strictly exceeds
  the Parent's.
- **No ground truth** — an anonymous LLM Judge compares Parent vs Candidate per
  validation task and outputs a winner; the Candidate is accepted only when it
  wins strictly more non-tie tasks than the Parent *and* records zero critical
  errors (wrong conclusion / contradiction / unanswered / execution failure).

This module owns the aggregation gate and the A/B anonymization helpers; it does
not implement ``score_fn`` or call the judge model — those belong to the
benchmark adapter and the Evolver respectively.
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional


class EvaluationGate:
    # ---- ground truth ------------------------------------------------------

    @staticmethod
    def decide_gt(parent_scores: List[float], candidate_scores: List[float]) -> Dict[str, Any]:
        if not parent_scores or not candidate_scores:
            raise ValueError("parent_scores and candidate_scores must be non-empty")
        parent_avg = sum(parent_scores) / len(parent_scores)
        candidate_avg = sum(candidate_scores) / len(candidate_scores)
        return {
            "accept": candidate_avg > parent_avg,
            "parent_score": parent_avg,
            "candidate_score": candidate_avg,
            "delta": candidate_avg - parent_avg,
            "protocol": "ground_truth",
        }

    # ---- LLM judge ---------------------------------------------------------

    @staticmethod
    def decide_judge(verdicts: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Aggregate decoded verdicts into an accept/reject decision.

        Each verdict: ``{"winner": "candidate"|"parent"|"tie",
        "critical_error": bool}``. ``critical_error`` marks a candidate hard
        error and is a hard reject condition.
        """
        w_c = w_p = ties = e_c = 0
        for verdict in verdicts:
            winner = verdict.get("winner")
            if winner == "candidate":
                w_c += 1
            elif winner == "parent":
                w_p += 1
            else:
                ties += 1
            if verdict.get("critical_error"):
                e_c += 1

        accept = (e_c == 0) and (w_c > w_p)
        return {
            "accept": accept,
            "candidate_wins": w_c,
            "parent_wins": w_p,
            "ties": ties,
            "candidate_critical_errors": e_c,
            "protocol": "llm_judge",
        }

    # ---- anonymization -----------------------------------------------------

    @staticmethod
    def anonymize(
        parent_answer: Any,
        candidate_answer: Any,
        swap: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Randomly label the two answers A/B (or force with ``swap``).

        Returns ``{"A": ..., "B": ..., "A_is": ..., "B_is": ...}`` so the judge
        never sees which side is the Parent or the Candidate.
        """
        candidate_first = random.random() < 0.5 if swap is None else bool(swap)
        if candidate_first:
            return {"A": candidate_answer, "B": parent_answer, "A_is": "candidate", "B_is": "parent"}
        return {"A": parent_answer, "B": candidate_answer, "A_is": "parent", "B_is": "candidate"}

    @staticmethod
    def decode(judgment: Dict[str, Any], mapping: Dict[str, str]) -> Dict[str, Any]:
        """Turn an A/B judgment back into candidate/parent terms.

        ``judgment``: ``{"winner": "A"|"B"|"tie", "reason": ...,
        "critical_error": "A"|"B"|bool|null}``. ``critical_error`` may point at a
        specific answer or be a bare boolean; it is resolved to whether the
        Candidate is the one with the hard error.
        """
        winner = judgment.get("winner")
        if winner in ("A", "B"):
            decoded_winner = mapping.get(f"{winner}_is", winner)
        else:
            decoded_winner = "tie"

        raw_ce = judgment.get("critical_error")
        if raw_ce in ("A", "B"):
            candidate_critical_error = mapping.get(f"{raw_ce}_is") == "candidate"
        elif isinstance(raw_ce, bool):
            candidate_critical_error = raw_ce
        else:
            candidate_critical_error = False

        return {
            "winner": decoded_winner,
            "critical_error": candidate_critical_error,
            "reason": judgment.get("reason", ""),
        }
