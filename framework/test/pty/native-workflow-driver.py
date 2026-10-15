"""State machine for observing and driving exact production-TUI workflow receipts."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

APPROVE_UNIT = re.compile(r"(?<![A-Z0-9_-])APPROVE-UNIT\s+(wf_[A-Za-z0-9_]+)\s+([0-9a-f]{64})(?![0-9a-f])")
RUN = re.compile(r"(?<![A-Z0-9_-])RUN\s+(wf_[A-Za-z0-9_]+)\s+([0-9a-f]{64})(?![0-9a-f])")


@dataclass
class ReceiptDriver:
    kind: str
    seen: set[str] = field(default_factory=set)
    submitted: list[str] = field(default_factory=list)

    def _pattern(self):
        if self.kind == "ultragoal":
            return APPROVE_UNIT
        if self.kind == "autoresearch":
            return RUN
        raise ValueError(f"unsupported receipt kind: {self.kind}")

    def next_complete_subject(self, text: str) -> str | None:
        """Return the newest unseen complete exact subject; partial/redrawn subjects remain inert."""
        matches = [f"{'APPROVE-UNIT' if self.kind == 'ultragoal' else 'RUN'} {wid} {sha}" for wid, sha in self._pattern().findall(text)]
        for subject in reversed(matches):
            if subject not in self.seen:
                return subject
        return None

    def mark_submitted(self, subject: str) -> None:
        if subject in self.seen:
            raise ValueError("single-use subject was already submitted")
        if self.next_complete_subject(subject) != subject:
            raise ValueError("subject is incomplete or malformed")
        self.seen.add(subject)
        self.submitted.append(subject)


def terminal_observation(kind: str, text: str) -> str | None:
    """Recognize only explicit product receipts, never infer terminal state from a prompt or redraw."""
    markers = {
        "ralplan": ("planning complete; not executed",),
        "ultragoal": ("Ultragoal complete.",),
        "autoresearch": ("Autoresearch finished", "Autoresearch complete."),
    }
    for marker in markers[kind]:
        if marker in text:
            return marker
    return None
