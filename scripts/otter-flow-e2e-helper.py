#!/usr/bin/env python3
"""Helper for otter-e2e.sh --flow plan: reads the isolated plugin state root's workflow.json/events.jsonl
(framework/src/flow/state.ts stateRoot/worktreeKey/workflowPath/eventsPath port) and the session ledger, and
prints small key=value / line-per-record reports consumed by the bash driver. Read-only.

Usage:
  otter-flow-e2e-helper.py state-root <XDG_STATE_HOME> <worktree>       -> prints the state root dir
  otter-flow-e2e-helper.py workflow <state_root>                        -> key=value summary of workflow.json (or none=1)
  otter-flow-e2e-helper.py events <state_root> [wf_id]                  -> one "seq type actor" line per event
  otter-flow-e2e-helper.py plan-check <state_root> <worktree> <wf_id>   -> F01: plan json validates + md exists
  otter-flow-e2e-helper.py ledger-check <state_root> <session_id> <wf_id> <expect_titles_file>
                                                                       -> F04: tagged task count/titles/status
  otter-flow-e2e-helper.py seed-task-check <state_root> <session_id> <seed_title>
                                                                       -> F07: seeded task cancelled, never run
"""
import hashlib
import json
import os
import sys


def canonical(path: str) -> str:
    try:
        return os.path.realpath(path)
    except OSError:
        return os.path.abspath(path)


def state_root(xdg_state_home: str, worktree: str) -> str:
    key = hashlib.sha1(canonical(worktree).encode("utf-8")).hexdigest()[:12]
    base = xdg_state_home or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "otter", key)


def read_json(path, default=None):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def read_events(state_root_dir, wf_id=None):
    path = os.path.join(state_root_dir, "workflow", "events.jsonl")
    out = []
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if wf_id and e.get("wf") != wf_id:
                continue
            out.append(e)
    return out


def cmd_state_root(args):
    xdg_state_home, worktree = args
    print(state_root(xdg_state_home, worktree))


def cmd_workflow(args):
    (root,) = args
    wf = read_json(os.path.join(root, "workflow", "workflow.json"))
    if not wf:
        print("none=1")
        return
    print("none=0")
    print("id=" + str(wf.get("id")))
    print("phase=" + str(wf.get("phase")))
    print("stuck_cause=" + str(wf.get("stuckCause") or ""))
    print("session_id=" + str(wf.get("sessionID")))
    print("entry=" + str(wf.get("entry")))
    task_ids = wf.get("taskIds") or []
    print("task_ids=" + ",".join(task_ids))
    plan_ref = wf.get("planRef") or {}
    print("plan_md_path=" + str(plan_ref.get("mdPath") or ""))


def cmd_events(args):
    root = args[0]
    wf_id = args[1] if len(args) > 1 else None
    for e in read_events(root, wf_id):
        print(f"{e.get('seq')} {e.get('type')} {e.get('actor')}")


def cmd_plan_check(args):
    root, worktree, wf_id = args
    plan_path = os.path.join(root, "workflow", "plans", f"{wf_id}.json")
    plan = read_json(plan_path)
    ok_json = bool(plan and isinstance(plan.get("steps"), list) and len(plan["steps"]) >= 1)
    md_path = os.path.join(worktree, ".otter", "plans", f"{wf_id}.md")
    ok_md = os.path.isfile(md_path)
    print("json_ok=" + ("1" if ok_json else "0"))
    print("md_ok=" + ("1" if ok_md else "0"))
    print("steps=" + str(len(plan.get("steps", [])) if plan else 0))
    if plan:
        print("titles=" + "|".join(s.get("title", "") for s in plan.get("steps", [])))


def cmd_ledger_check(args):
    root, session_id, wf_id, titles_file = args
    ledger = read_json(os.path.join(root, "sessions", session_id, "ledger.json"), {"tasks": []})
    tasks = [t for t in ledger.get("tasks", []) if (t.get("wf") or {}).get("id") == wf_id]
    print("n=" + str(len(tasks)))
    print("titles=" + "|".join(t.get("title", "") for t in tasks))
    print("statuses=" + ",".join(t.get("status", "") for t in tasks))
    expect_titles = []
    if os.path.isfile(titles_file):
        with open(titles_file, encoding="utf-8") as f:
            expect_titles = [line.rstrip("\n") for line in f if line.strip()]
    titles_match = [t.get("title", "") for t in tasks] == expect_titles
    all_done = all(t.get("status") == "done" for t in tasks) and len(tasks) > 0
    print("titles_match=" + ("1" if titles_match else "0"))
    print("all_done=" + ("1" if all_done else "0"))


def cmd_seed_task_check(args):
    root, session_id, seed_title = args
    ledger = read_json(os.path.join(root, "sessions", session_id, "ledger.json"), {"tasks": []})
    seeded = [t for t in ledger.get("tasks", []) if t.get("title") == seed_title]
    if not seeded:
        print("found=0")
        return
    t = seeded[0]
    print("found=1")
    print("status=" + str(t.get("status")))
    print("error=" + str(t.get("error") or ""))
    print("ran=" + ("1" if t.get("attempts", 0) > 0 else "0"))
    print("superseded=" + ("1" if "superseded" in str(t.get("error") or "") else "0"))


COMMANDS = {
    "state-root": cmd_state_root,
    "workflow": cmd_workflow,
    "events": cmd_events,
    "plan-check": cmd_plan_check,
    "ledger-check": cmd_ledger_check,
    "seed-task-check": cmd_seed_task_check,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: {sys.argv[0]} <{'|'.join(COMMANDS)}> ...", file=sys.stderr)
        return 3
    COMMANDS[sys.argv[1]](sys.argv[2:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
