"""Evolution trigger: decide whether to remind the user to evolve.

The trigger only decides *whether* to remind — it never starts the Evolver.
Two conditions (OR): at least ``min_new_trajectories`` new tasks since the
checkpoint, or at least ``min_days`` elapsed since the checkpoint. Checkpoints
live in ``<workspace>/state.json``; after a formal evolution gate completes,
:meth:`EvolutionTrigger.advance_checkpoint` resets them and clears
``evolution_due``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..trajectory.trajectory import TrajectoryStore
from ..workspace import PathLike, resolve_workspace

DEFAULT_MIN_TRAJECTORIES = 30
DEFAULT_MIN_DAYS = 7


class EvolutionTrigger:
    def __init__(
        self,
        root: Optional[PathLike] = None,
        min_new_trajectories: int = DEFAULT_MIN_TRAJECTORIES,
        min_days: int = DEFAULT_MIN_DAYS,
    ):
        self.root = resolve_workspace(root)
        self.trajectories = TrajectoryStore(str(self.root))
        self.state_path = self.root / "state.json"
        self._default_min_new = min_new_trajectories
        self._default_min_days = min_days

    # ---- state -------------------------------------------------------------

    def _load_state(self) -> Dict[str, Any]:
        if not self.state_path.is_file():
            return {}
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        return state if isinstance(state, dict) else {}

    def _save_state(self, state: Dict[str, Any]) -> None:
        self.state_path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _thresholds(self) -> Dict[str, int]:
        state = self._load_state()
        thresholds = state.get("thresholds", {})
        if not isinstance(thresholds, dict):
            thresholds = {}
        return {
            "min_new_trajectories": int(
                thresholds.get("min_new_trajectories", self._default_min_new)
            ),
            "min_days": int(thresholds.get("min_days", self._default_min_days)),
        }

    def initialize(self, when: Optional[datetime] = None) -> Dict[str, Any]:
        """Create the initial trigger state once and return the current state.

        The operation is idempotent: an existing valid state is never reset.
        No trajectory checkpoint is recorded here, so trajectories collected
        before a legacy workspace is initialized still count toward the first
        evolution reminder.
        """
        state = self._load_state()
        existing_time = state.get("checkpoint_time") or state.get(
            "last_evolution_time"
        )
        existing_trajectory = state.get("checkpoint_trajectory")
        if existing_trajectory is None:
            existing_trajectory = state.get("last_evolution_trajectory")
        if existing_time:
            normalized = {
                "checkpoint_trajectory": existing_trajectory,
                "checkpoint_time": existing_time,
                "evolution_due": bool(state.get("evolution_due", False)),
                "thresholds": self._thresholds(),
            }
            if normalized != state:
                self._save_state(normalized)
            return normalized

        checkpoint = when or datetime.now(timezone.utc)
        state = {
            "checkpoint_trajectory": existing_trajectory,
            "checkpoint_time": checkpoint.isoformat(),
            "evolution_due": False,
            "thresholds": self._thresholds(),
        }
        self.root.mkdir(parents=True, exist_ok=True)
        self._save_state(state)
        return state

    # ---- check -------------------------------------------------------------

    def check(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        """Return whether evolution is due, with the supporting numbers.

        ``now`` is injectable for deterministic tests.
        """
        state = self._load_state()
        thresholds = self._thresholds()
        min_new = thresholds["min_new_trajectories"]
        min_days = thresholds["min_days"]

        checkpoint_trajectory = state.get("checkpoint_trajectory")
        if checkpoint_trajectory is None:
            checkpoint_trajectory = state.get("last_evolution_trajectory")
        checkpoint_time = state.get("checkpoint_time") or state.get(
            "last_evolution_time"
        )

        new_count = self.trajectories.count_since(
            checkpoint_trajectory if checkpoint_trajectory else None
        )

        due_by_count = new_count >= min_new
        due_by_time = False
        days_since = None
        if checkpoint_time:
            try:
                last_dt = datetime.fromisoformat(str(checkpoint_time))
            except ValueError:
                last_dt = None
            if last_dt is not None:
                current = now or datetime.now(timezone.utc)
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=timezone.utc)
                days_since = (current - last_dt).total_seconds() / 86400.0
                due_by_time = days_since >= min_days

        evolution_due = due_by_count or due_by_time

        if state and state.get("evolution_due") != evolution_due:
            state["evolution_due"] = evolution_due
            self._save_state(state)

        reasons = []
        if due_by_count:
            reasons.append(f"{new_count} new trajectories >= {min_new}")
        if due_by_time:
            reasons.append(f"{days_since:.1f} days since checkpoint >= {min_days}")

        return {
            "evolution_due": evolution_due,
            "new_trajectories": new_count,
            "days_since_checkpoint": round(days_since, 3) if days_since is not None else None,
            "reason": " OR ".join(reasons) if reasons else "not due",
            "thresholds": thresholds,
        }

    def advance_checkpoint(
        self,
        last_trajectory_id: Optional[str] = None,
        when: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Advance the checkpoint after a completed formal evolution gate.

        When ``last_trajectory_id`` is omitted, the most recently recorded task
        becomes the checkpoint so the next round only analyzes newer tasks.
        ``when`` injects the checkpoint timestamp for deterministic tests.
        """
        if last_trajectory_id is None:
            all_trajs = self.trajectories.list_since(None)
            if all_trajs:
                last_trajectory_id = str(all_trajs[-1].get("task_id"))

        checkpoint = when or datetime.now(timezone.utc)
        thresholds = self._thresholds()
        state = {
            "checkpoint_trajectory": last_trajectory_id,
            "checkpoint_time": checkpoint.isoformat(),
            "evolution_due": False,
            "thresholds": thresholds,
        }
        self._save_state(state)
        return state

    def mark_evolved(
        self,
        last_trajectory_id: Optional[str] = None,
        when: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Backward-compatible alias for :meth:`advance_checkpoint`."""
        return self.advance_checkpoint(last_trajectory_id, when)
