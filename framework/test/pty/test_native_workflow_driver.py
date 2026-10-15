from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MODULE = Path(__file__).with_name("native-workflow-driver.py")
SPEC = importlib.util.spec_from_file_location("native_workflow_driver", MODULE)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

ReceiptDriver = mod.ReceiptDriver
terminal_observation = mod.terminal_observation
SHA1 = "1" * 64
SHA2 = "2" * 64


def test_partial_subject_never_submits():
    driver = ReceiptDriver("ultragoal")
    assert driver.next_complete_subject(f"Type exactly: APPROVE-UNIT wf_one {SHA1[:-1]}") is None
    assert driver.submitted == []


def test_redraw_never_resubmits_consumed_subject():
    driver = ReceiptDriver("ultragoal")
    subject = f"APPROVE-UNIT wf_one {SHA1}"
    assert driver.next_complete_subject(subject) == subject
    driver.mark_submitted(subject)
    assert driver.next_complete_subject(f"redraw\n{subject}\nredraw again\n{subject}") is None


def test_distinct_subject_remains_usable_after_redraw():
    driver = ReceiptDriver("autoresearch")
    first = f"RUN wf_research {SHA1}"
    second = f"RUN wf_research {SHA2}"
    driver.mark_submitted(first)
    assert driver.next_complete_subject(f"old {first}\nnew {second}") == second
    driver.mark_submitted(second)
    assert driver.submitted == [first, second]


def test_terminal_receipts_are_observed_without_guessing():
    assert terminal_observation("ralplan", "planning complete; not executed")
    assert terminal_observation("ultragoal", "Ultragoal complete.")
    assert terminal_observation("autoresearch", "Autoresearch finished (done).")
    assert terminal_observation("ralplan", "Consensus reached: execution pending") is None
    assert terminal_observation("ultragoal", "Type exactly: APPROVE-UNIT wf_x " + SHA1) is None
    assert terminal_observation("autoresearch", "Experiment approved; running through verifier") is None
