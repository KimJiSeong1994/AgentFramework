#!/usr/bin/env python3
"""lca stage 4: headless ontology evolution round(s) for the EvoOntology workspace of the data fixture.

    python3 scripts/lca-evo-evolve.py                 # evaluate the active version, propose + evaluate candidates
    python3 scripts/lca-evo-evolve.py --rounds 2 --tier 2 --force
    python3 scripts/lca-evo-evolve.py --dry-run       # parent evaluation + evolver prompt only (no proposal call)
    python3 scripts/lca-evo-evolve.py --activate ontology_v1     # the human approval step (flips active.json)
    python3 scripts/lca-evo-evolve.py --self-test     # patch validation unit checks (no model, no GPU)
    python3 scripts/lca-evo-evolve.py --questions q.jsonl --protocol llm_judge   # questions without `expected`:
        # the `answer-judge` agent compares anonymized parent/candidate answers per case (EvoOntology llm_judge gate)
    python3 scripts/lca-evo-evolve.py --no-ground-truth   # same, using the fixture questions with `expected` stripped

One run = one EvoOntology evolution run (`<workspace>/evolution/run_N/`):
  1. parent evaluation: `scripts/lca-e2e-data.sh` on the active version (the harness re-executes the model's SQL and
     compares with the expected result) -> per-case scores 1/0, trajectories appended to `<workspace>/trajectories/`
  2. per round: the `ontology-evolver` agent (Gemma, no tools) gets the current terms/constraints + the failed cases
     and returns a JSON patch (aliases on existing terms, new terms, new constraints). The patch is validated in
     code, applied to a copy of the parent records, saved as `candidate_rN`, validated (`validate_semantics`).
  3. candidate evaluation: the same e2e on a temporary workspace whose active version is the candidate.
  4. gate (EvoOntology `ground_truth` protocol, deterministic): candidate mean > parent mean -> accepted and
     published as the next `ontology_vN` — but `active.json` is put BACK to the parent: activation is a human
     decision (`--activate`), the proposal is `evolution/run_N/proposal.md` + the new version directory (PR diff).
     Otherwise the round is recorded as a reject and the next round gets the previous hypothesis + its result.

With ground truth (`expected` in the question file) the judge is code (result match). Without it the protocol is
EvoOntology's `llm_judge`: for every case the `answer-judge` agent (same Gemma, no tools) sees the question and the two
answers (SQL + first rows) labelled A/B at random, names a winner and any critical error; the candidate is accepted
only with zero critical errors and strictly more wins. The evolver never sees expected answers, only that a case
failed (or, without ground truth, that mentions went unresolved / the query errored) and what the ontology lacked.
Stdlib only; the vendored EvoOntology package is imported from framework/vendor.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "framework" / "vendor" / "evoontology"
sys.path.insert(0, str(VENDOR))

from evoontology import EvaluationGate, EvolutionSession, SemanticStore, TrajectoryStore  # noqa: E402
from evoontology.validate import validate  # noqa: E402

E2E = ROOT / "scripts" / "lca-e2e-data.sh"
EVOLVER = "ontology-evolver"
JUDGE = "answer-judge"
TERM_ID_RE = re.compile(r"^t-[a-z0-9][a-z0-9-]{0,40}$")
CONSTRAINT_ID_RE = re.compile(r"^c-[a-z0-9][a-z0-9-]{0,40}$")
TERM_TYPES = {"entity", "dimension", "measure", "event", "attribute"}
CONSTRAINT_TYPES = {"convention", "value_format", "value_domain", "dialect", "access"}


def log(msg: str) -> None:
    print(f"evo: {msg}", flush=True)


# ------------------------------------------------------------------ patch model (pure, unit-tested by --self-test)

class PatchError(ValueError):
    pass


def parse_patch(text: str) -> dict:
    """The evolver's reply: one JSON object, tolerating fences and stray prose around it."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        raise PatchError("no JSON object in the reply")
    try:
        obj = json.loads(t[i : j + 1])
    except json.JSONDecodeError as e:
        raise PatchError(f"invalid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise PatchError("reply is not a JSON object")
    return obj


def _strs(v, what: str, max_len: int = 80) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise PatchError(f"{what} must be a list of strings")
    out = []
    for x in v:
        s = " ".join(x.split())
        if not s or len(s) > max_len:
            raise PatchError(f"{what}: bad value {x!r}")
        if s not in out:
            out.append(s)
    return out


def apply_patch(records: dict, patch: dict) -> tuple[dict, dict]:
    """Return (new records, summary). Additive only: aliases on existing terms, new terms, new constraints.
    Raises PatchError on anything that would not validate or that removes/renames. Never mutates `records`."""
    new = copy.deepcopy(records)
    terms = {t["id"]: t for t in new.get("terms", [])}
    constraints = {c["id"]: c for c in new.get("constraints", [])}
    mappings = {m["id"] for m in new.get("mappings", [])}
    all_aliases = {a.casefold() for t in terms.values() for a in [t.get("name", ""), *(t.get("aliases") or [])] if a}
    summary = {"hypothesis": str(patch.get("hypothesis") or "").strip()[:300], "aliases": {}, "terms": [], "constraints": []}

    for entry in patch.get("aliases") or []:
        if not isinstance(entry, dict):
            raise PatchError("aliases[] entries must be objects")
        tid = str(entry.get("term_id") or "")
        if tid not in terms:
            raise PatchError(f"aliases: unknown term_id {tid!r}")
        added = []
        for a in _strs(entry.get("add"), f"aliases[{tid}].add"):
            if a.casefold() in all_aliases:
                continue
            terms[tid].setdefault("aliases", []).append(a)
            all_aliases.add(a.casefold())
            added.append(a)
        if added:
            summary["aliases"][tid] = added

    for t in patch.get("terms") or []:
        if not isinstance(t, dict):
            raise PatchError("terms[] entries must be objects")
        tid = str(t.get("id") or "")
        if not TERM_ID_RE.match(tid):
            raise PatchError(f"terms: bad id {tid!r} (t-<slug>)")
        if tid in terms:
            # a weak model re-lists an existing term to extend it: keep only the new aliases (never its name/definition)
            added = []
            for a in _strs(t.get("aliases"), f"terms[{tid}].aliases"):
                if a.casefold() in all_aliases:
                    continue
                terms[tid].setdefault("aliases", []).append(a)
                all_aliases.add(a.casefold())
                added.append(a)
            if added:
                summary["aliases"].setdefault(tid, []).extend(added)
            continue
        name = " ".join(str(t.get("name") or "").split())
        if not name or len(name) > 60:
            raise PatchError(f"terms[{tid}]: name required")
        if name.casefold() in all_aliases:
            raise PatchError(f"terms[{tid}]: name {name!r} already names another term; add an alias instead")
        ttype = str(t.get("type") or "entity")
        if ttype not in TERM_TYPES:
            raise PatchError(f"terms[{tid}]: type must be one of {sorted(TERM_TYPES)}")
        definition = " ".join(str(t.get("definition") or "").split())
        if not definition or len(definition) > 400:
            raise PatchError(f"terms[{tid}]: definition required (<= 400 chars)")
        aliases = [a for a in _strs(t.get("aliases"), f"terms[{tid}].aliases") if a.casefold() not in all_aliases and a.casefold() != name.casefold()]
        rec = {"id": tid, "name": name, "type": ttype, "definition": definition, "scope": next((x.get("scope") for x in terms.values() if x.get("scope")), ""), "aliases": aliases, "evidence": []}
        new.setdefault("terms", []).append(rec)
        terms[tid] = rec
        all_aliases.update({name.casefold(), *(a.casefold() for a in aliases)})
        summary["terms"].append(tid)

    for c in patch.get("constraints") or []:
        if not isinstance(c, dict):
            raise PatchError("constraints[] entries must be objects")
        cid = str(c.get("id") or "")
        if not CONSTRAINT_ID_RE.match(cid):
            raise PatchError(f"constraints: bad id {cid!r} (c-<slug>)")
        if cid in constraints:
            raise PatchError(f"constraints: {cid} already exists")
        target = str(c.get("target") or "")
        if target not in terms and target not in mappings:
            raise PatchError(f"constraints[{cid}]: target {target!r} is not a term or mapping id")
        ctype = str(c.get("constraint_type") or c.get("type") or "convention")
        if ctype not in CONSTRAINT_TYPES:
            raise PatchError(f"constraints[{cid}]: constraint_type must be one of {sorted(CONSTRAINT_TYPES)}")
        keywords = _strs(c.get("trigger_keywords"), f"constraints[{cid}].trigger_keywords")
        if not keywords:
            raise PatchError(f"constraints[{cid}]: trigger_keywords required")
        desc = " ".join(str(c.get("description") or "").split())
        if not desc or len(desc) > 400:
            raise PatchError(f"constraints[{cid}]: description required (<= 400 chars)")
        sev = str(c.get("severity") or "warn")
        if sev not in {"info", "warn", "block"}:
            sev = "warn"
        rec = {"id": cid, "target": target, "constraint_type": ctype, "trigger_keywords": keywords, "severity": sev, "scope": str(c.get("scope") or ""), "description": desc}
        new.setdefault("constraints", []).append(rec)
        constraints[cid] = rec
        summary["constraints"].append(cid)

    if not (summary["aliases"] or summary["terms"] or summary["constraints"]):
        raise PatchError("empty patch (nothing new to add)")
    return new, summary


def compact_terms(records: dict, max_chars: int = 6000) -> str:
    lines = []
    for t in records.get("terms", []):
        al = ", ".join((t.get("aliases") or [])[:12])
        lines.append(f"{t['id']} | {t.get('name','')} | {al}")
    text = "\n".join(lines)
    return text[:max_chars]


def compact_constraints(records: dict, max_chars: int = 3000) -> str:
    lines = []
    for c in records.get("constraints", []):
        kw = ", ".join((c.get("trigger_keywords") or [])[:6])
        lines.append(f"{c['id']} | {kw} | {str(c.get('description',''))[:120]}")
    return "\n".join(lines)[:max_chars]


def evolver_prompt(records: dict, failed: list[dict], previous: dict | None = None) -> str:
    lines = ["Current terms (id | name | aliases):", compact_terms(records), "", "Constraints (id | keywords | rule):", compact_constraints(records) or "(none)", "", f"Failed cases ({len(failed)}):"]
    for i, c in enumerate(failed, 1):
        lines.append(f"{i}. Question: {c['question']}")
        lines.append(f"   Unresolved mentions: {', '.join(c.get('unresolved') or []) or '(all resolved)'}")
        if c.get("sql"):
            lines.append(f"   SQL written: {c['sql'][:300]}")
        lines.append(f"   Why wrong: {c.get('note') or 'result did not match the expected answer'}")
    if previous:
        lines += ["", f"Previous round hypothesis: {previous.get('hypothesis','')}", f"Previous round result: {previous.get('result','')}. Propose something different."]
    lines += ["", "Return the JSON patch now."]
    return "\n".join(lines)


def judge_prompt(question: str, a: dict, b: dict, conventions: str = "") -> str:
    def block(label, ans):
        sql = (ans.get("sql") or "").strip() or "(no SQL)"
        rows = ans.get("rows") or ""
        if isinstance(rows, dict):
            rows = "\t".join(rows.get("columns", [])) + "\n" + "\n".join("\t".join(str(v) for v in r) for r in rows.get("rows", []))
        return [f"Answer {label}:", "SQL: " + sql[:1500], "First rows: " + (str(rows)[:400] or "(none)"), ""]
    head = [f"Question: {question}", ""]
    if conventions:
        head += ["Domain conventions the SQL must follow (from the ontology):", conventions, ""]
    return "\n".join([*head, *block("A", a), *block("B", b), "Return the JSON verdict now."])


def conventions_text(records: dict, max_chars: int = 1500) -> str:
    """Constraints as one line each, for the judge: without them a 26B judge prefers the simpler SQL (stage-4 run)."""
    lines = []
    for c in records.get("constraints", []):
        if c.get("severity") == "info":
            continue
        lines.append(f"- {str(c.get('description', ''))[:160]}")
    return "\n".join(lines)[:max_chars]


def judge_twice(question: str, parent: dict, candidate: dict, conventions: str, call) -> dict:
    """Two anonymized passes with A/B swapped; a winner counts only when both passes agree, a critical error when
    either pass flags the candidate (conservative for the parent). Returns {winner, critical_error, reason}."""
    outcomes = []
    for swap in (False, True):
        ab = EvaluationGate.anonymize(parent, candidate, swap=swap)
        decoded = EvaluationGate.decode(parse_judgment(call(judge_prompt(question, ab["A"], ab["B"], conventions))), ab)
        outcomes.append(decoded)
    winners = {o["winner"] for o in outcomes}
    winner = outcomes[0]["winner"] if len(winners) == 1 else "tie"
    critical = any(bool(o.get("critical_error")) for o in outcomes)
    reason = " | ".join(str(o.get("reason", ""))[:90] for o in outcomes)
    if len(winners) > 1:
        reason = "passes disagree (" + "/".join(o["winner"] for o in outcomes) + "): " + reason
    return {"winner": winner, "critical_error": critical, "reason": reason}


def parse_judgment(text: str) -> dict:
    """{"winner": "A"|"B"|"tie", "critical_error": "A"|"B"|null, "reason"} from the judge's reply; tie on garbage."""
    try:
        obj = parse_patch(text)
    except PatchError:
        return {"winner": "tie", "critical_error": None, "reason": "unparseable verdict"}
    w = str(obj.get("winner") or "tie").strip().upper()
    winner = w if w in ("A", "B") else "tie"
    ce = obj.get("critical_error")
    ce = ce.strip().upper() if isinstance(ce, str) else None
    if ce not in ("A", "B"):
        ce = None
    return {"winner": winner, "critical_error": ce, "reason": str(obj.get("reason") or "")[:200]}


# ------------------------------------------------------------------ e2e evaluation

def run_e2e(workspace: Path, tier: int, scratch: Path, extra: list[str] | None = None, qfile: Path | None = None) -> tuple[dict, Path]:
    """Run scripts/lca-e2e-data.sh on `workspace`; return ({qid: case}, results tsv path). match: 1/0, or -1 without ground truth."""
    cmd = ["bash", str(E2E), "--tier", str(tier), "--evo-workspace", str(workspace), "--scratch", str(scratch), "--min-pass", "0", *(["--questions", str(qfile)] if qfile else []), *(extra or [])]
    log("e2e: " + " ".join(cmd[1:]))
    p = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "LCA_DEBUG": os.environ.get("LCA_DEBUG", "")})
    m = re.search(r"^results: (.+)$", p.stdout, re.M)
    if not m:
        sys.stderr.write(p.stdout[-2000:] + p.stderr[-2000:])
        raise SystemExit("e2e produced no results file")
    tsv = Path(m.group(1).strip())
    cases = {}
    for line in tsv.read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        if len(f) < 12:
            continue
        rows = None
        if len(f) > 14 and f[14]:
            try:
                rows = json.loads(f[14])
            except json.JSONDecodeError:
                rows = None
        cases[f[0]] = {"id": f[0], "tier": int(f[1]), "match": int(f[2]), "tokens": int(f[3]), "tools": int(f[4]), "resolve": int(f[7]), "note": f[9], "sql": f[10], "unresolved": json.loads(f[13]) if len(f) > 13 and f[13] else [], "rows": rows}
    for line in p.stdout.splitlines():
        if re.match(r"^[A-Z]+-(MAP-)?[0-9]+:", line):
            log("  " + line)
    return cases, tsv


def questions(qfile: Path) -> dict:
    return {q["id"]: q for q in (json.loads(l) for l in qfile.read_text(encoding="utf-8").splitlines() if l.strip())}


def case_failed(c: dict) -> bool:
    """Ground truth: mismatch. Without it: the ontology left mentions unresolved, or the query produced nothing usable."""
    if c["match"] == 0:
        return True
    if c["match"] == -1:
        if c["unresolved"]:
            return True
        n = c.get("note") or ""
        if n.startswith("sql error") or n.startswith("no SQL") or n.startswith("re-exec failed"):
            return True
        rows = c.get("rows") or {}
        if isinstance(rows, dict) and not rows.get("rows"):
            return True
    return False


def record_trajectories(workspace: Path, version: str, cases: dict, qs: dict, stamp: str) -> int:
    store = TrajectoryStore(str(workspace))
    n = 0
    for qid, c in cases.items():
        store.append({
            "task_id": f"e2e-{stamp}-{qid}",
            "question": qs[qid]["question"],
            "question_id": qid,
            "data_source": "fixture sqlite",
            "origin": "workload",
            "ontology_version": version,
            "split": "construction",
            "semantic_calls": [{"tool": "resolve_semantics", "unresolved": c["unresolved"], "calls": c["resolve"]}],
            "native_tool_calls": [{"tool": "db_query", "sql": c["sql"]}] if c["sql"] else [],
            "final_answer": c["sql"],
            "task_status": "completed" if c["match"] else "failed",
            "errors": [] if c["match"] else [c["note"] or "result mismatch"],
        })
        n += 1
    return n


# ------------------------------------------------------------------ evolver call (isolated OpenCode like the e2e)

def call_agent(agent: str, prompt: str, scratch: Path, fixture: Path, timeout: int) -> str:
    e2e = scratch / "lca-e2e"
    cfg_home, data_home, state_home = e2e / "config", e2e / "data", e2e / "state"
    if not (cfg_home / "opencode" / "opencode.json").is_file():
        raise SystemExit("isolated OpenCode config missing; run scripts/lca-e2e-data.sh --check first")
    work = e2e / "work" / f"evo-{int(time.time())}"
    (work / ".opencode" / "plugins").mkdir(parents=True)
    (work / ".lca").mkdir()
    (work / ".opencode" / "plugins" / "lca.ts").write_text(f'export {{ LcaPlugin }} from "{ROOT}/framework/src/index.ts"\n')
    (work / ".lca" / "lca.jsonc").write_text(json.dumps({"data": {"backend": "sqlite", "sqlite_path": str(fixture / "data" / "vehicle_visit.sqlite"), "schema_file": str(fixture / "data" / "schema.json"), "evo": {"enabled": False}}}))
    env = {k: v for k, v in os.environ.items() if k not in ("OPENCODE_CONFIG_DIR", "ORCA_OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT")}
    # OpenCode takes the project from $PWD (not the process cwd) and the plugin reads .lca/lca.jsonc from the git
    # worktree: set both, as the e2e script's `cd` does implicitly
    env.update({"XDG_CONFIG_HOME": str(cfg_home), "XDG_DATA_HOME": str(data_home), "XDG_STATE_HOME": str(state_home), "PWD": str(work)})
    subprocess.run(["git", "init", "-q"], cwd=work, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.name=lca-evo", "-c", "user.email=lca-evo@localhost", "-c", "commit.gpgsign=false", "add", "-A"], cwd=work, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.name=lca-evo", "-c", "user.email=lca-evo@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "evolver work dir"], cwd=work, check=True, capture_output=True)
    t0 = int(time.time() * 1000)
    log(f"{agent}: opencode run ({len(prompt)} chars)")
    p = subprocess.run(["opencode", "run", "--format", "json", "--agent", agent, "--auto", prompt], cwd=work, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    (work / "evolver.out").write_text(p.stdout)
    (work / "evolver.err").write_text(p.stderr)
    db = data_home / "opencode" / "opencode.db"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute("select id from session where parent_id is null and time_created >= ? and directory = ? order by time_created desc limit 1", (t0 - 5000, str(work))).fetchone()
    if not row:
        raise SystemExit(f"{agent} session not found (rc={p.returncode}): {p.stderr[-500:]}")
    texts = [json.loads(d).get("text") or "" for (d,) in con.execute("select data from part where session_id=? and json_extract(data,'$.type')='text' order by time_created", (row[0],))]
    tools = con.execute("select count(*) from part where session_id=? and json_extract(data,'$.type')='tool'", (row[0],)).fetchone()[0]
    if tools:
        log(f"warning: {agent} made {tools} tool call(s) (should be 0)")
    return texts[-1] if texts else ""


# ------------------------------------------------------------------ main flow

def evolve(args) -> int:
    fixture = Path(args.fixture).resolve()
    workspace = Path(args.workspace or (fixture / ".evoontology")).resolve()
    scratch = Path(args.scratch).expanduser().resolve()
    qfile = Path(args.questions).resolve() if args.questions else fixture / "queries.jsonl"
    if args.no_ground_truth:
        stripped = scratch / "lca-e2e" / "questions-nogt.jsonl"
        stripped.parent.mkdir(parents=True, exist_ok=True)
        with stripped.open("w", encoding="utf-8") as f:
            for q in questions(qfile).values():
                f.write(json.dumps({k: v for k, v in q.items() if k != "expected"}, ensure_ascii=False) + "\n")
        qfile = stripped
    qs = questions(qfile)
    has_gt = all("expected" in q for q in qs.values())
    protocol = args.protocol or ("ground_truth" if has_gt else "llm_judge")
    if protocol == "ground_truth" and not has_gt:
        raise SystemExit("ground_truth protocol needs `expected` on every question; use --protocol llm_judge")
    parent = SemanticStore.active_version(str(workspace))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    log(f"workspace {workspace} active={parent} tier<={args.tier} protocol={protocol} questions={qfile.name} ({len(qs)})")

    # 1. parent evaluation
    parent_cases, parent_tsv = run_e2e(workspace, args.tier, scratch, qfile=qfile)
    ids = sorted(parent_cases)
    p_scores = [max(0, parent_cases[i]["match"]) for i in ids]
    if protocol == "ground_truth":
        log(f"parent {parent}: {sum(p_scores)}/{len(ids)} matched")
    else:
        log(f"parent {parent}: {len(ids)} answers captured, {sum(1 for i in ids if case_failed(parent_cases[i]))} with unresolved mentions / unusable results")
    n = record_trajectories(workspace, parent, parent_cases, qs, stamp)
    log(f"trajectories appended: {n}")
    failed = [{"question": qs[i]["question"], **parent_cases[i]} for i in ids if case_failed(parent_cases[i])]
    if not failed and not args.force:
        log("nothing to evolve (every case matched); use --force to try anyway")
        return 0
    _, parent_records = SemanticStore.load_records(str(workspace), parent)
    if args.dry_run:
        print(evolver_prompt(parent_records, failed))
        return 0

    # 2. evolution run
    session = EvolutionSession(str(workspace))
    latest = session.latest_run()
    if latest and latest.get("status") == "running":
        log(f"resuming {latest['run_id']} (still running)")
        session.resume()
    else:
        session.start_run(parent, adapter="lca-e2e-data", max_rounds=args.rounds, acceptance={"protocol": protocol, "judge": "code: result match on the question file" if protocol == "ground_truth" else f"{JUDGE} agent, anonymized A/B per case"})
    session.confirm_trajectory_sources([{"path": str(workspace / "trajectories"), "scope": f"e2e-{stamp}-*", "purpose": "parent evaluation of this run"}])
    session.record_evaluation(parent, {"metrics": {"matched": sum(p_scores), "cases": len(ids), "mean": sum(p_scores) / len(ids)}, "cases": [{"id": i, "score": parent_cases[i]["match"]} for i in ids], "artifact_paths": [str(parent_tsv)], "provenance": "scripts/lca-e2e-data.sh"}, role="parent")
    run_dir = Path(session.run_dir)
    previous = None
    for rnd in range(1, args.rounds + 1):
        prompt = evolver_prompt(parent_records, failed, previous)
        (run_dir / f"round{rnd}_prompt.txt").write_text(prompt, encoding="utf-8")
        reply = call_agent(EVOLVER, prompt, scratch, fixture, args.model_timeout)
        (run_dir / f"round{rnd}_reply.txt").write_text(reply, encoding="utf-8")
        try:
            patch = parse_patch(reply)
            cand_records, summary = apply_patch(parent_records, patch)
        except PatchError as e:
            log(f"round {rnd}: patch rejected before evaluation: {e}")
            previous = {"hypothesis": "(unusable reply)", "result": f"the patch was invalid: {e}"}
            session.begin_round(f"(invalid patch) {e}", "")
            session.record_round(decision="reject", metrics={}, notes=f"invalid patch: {e}")
            continue
        candidate = f"candidate_r{session.run['round'] + 1}_{stamp}"
        SemanticStore.save_version(str(workspace), candidate, cand_records)
        v = validate(str(workspace), version=candidate)
        if not v["passed"]:
            log(f"round {rnd}: candidate does not validate: {v['errors'][:3]}")
            session.begin_round(summary["hypothesis"], candidate)
            session.record_round(decision="reject", metrics={}, notes=f"validation: {v['errors'][:3]}")
            previous = {"hypothesis": summary["hypothesis"], "result": f"candidate failed validation: {v['errors'][:2]}"}
            continue
        session.begin_round(summary["hypothesis"] or "(no hypothesis given)", candidate)
        log(f"round {rnd}: hypothesis: {summary['hypothesis']}")
        log(f"round {rnd}: patch: aliases={summary['aliases']} terms={summary['terms']} constraints={summary['constraints']}")

        # 3. candidate evaluation on a temp workspace copy with the candidate active
        with tempfile.TemporaryDirectory(prefix="lca-evo-cand-") as tmp:
            cand_ws = Path(tmp) / ".evoontology"
            shutil.copytree(workspace, cand_ws, ignore=shutil.ignore_patterns("trajectories", "evolution", "tasks", "visualizations"))
            SemanticStore.set_active(str(cand_ws), candidate)
            cand_cases, cand_tsv = run_e2e(cand_ws, args.tier, scratch, qfile=qfile)
        c_scores = [max(0, cand_cases.get(i, {"match": 0})["match"]) for i in ids]
        if protocol == "ground_truth":
            log(f"candidate {candidate}: {sum(c_scores)}/{len(ids)} matched (parent {sum(p_scores)})")
            gate_input = {"protocol": "ground_truth", "unacceptable_regressions": False, "parent_scores": p_scores, "candidate_scores": c_scores, "case_ids": ids}
            regressions = [i for i, a, b in zip(ids, p_scores, c_scores) if a and not b]
            accept = sum(c_scores) > sum(p_scores) and not regressions
            why = f"candidate {sum(c_scores)} vs parent {sum(p_scores)}" + (f", regressions: {regressions}" if regressions else "")
            case_rows = [{"id": i, "parent": parent_cases[i]["match"], "candidate": cand_cases.get(i, {}).get("match", 0)} for i in ids]
        else:
            # llm_judge: one anonymized A/B call per case; the judge never learns which side is the candidate
            verdicts, case_rows = [], []
            conventions = conventions_text(cand_records)  # the candidate's constraints include the parent's
            for i in ids:
                decoded = judge_twice(qs[i]["question"], {"sql": parent_cases[i]["sql"], "rows": parent_cases[i].get("rows")}, {"sql": cand_cases.get(i, {}).get("sql", ""), "rows": cand_cases.get(i, {}).get("rows")}, conventions,
                                      lambda prompt: call_agent(JUDGE, prompt, scratch, fixture, args.model_timeout))
                verdicts.append({"winner": decoded["winner"], "critical_error": bool(decoded.get("critical_error"))})
                case_rows.append({"id": i, "winner": decoded["winner"], "candidate_critical_error": bool(decoded.get("critical_error")), "reason": decoded.get("reason", "")[:200]})
                log(f"  judge {i}: {decoded['winner']}{' CRITICAL' if decoded.get('critical_error') else ''} — {decoded.get('reason', '')[:100]}")
            gate = EvaluationGate.decide_judge(verdicts)
            gate_input = {"protocol": "llm_judge", "unacceptable_regressions": False, "verdicts": verdicts}
            accept = bool(gate["accept"])
            why = f"candidate wins {gate['candidate_wins']}, parent wins {gate['parent_wins']}, ties {gate['ties']}, candidate critical errors {gate['candidate_critical_errors']}"
            c_scores = [1 if v["winner"] == "candidate" else 0 for v in verdicts]
            p_scores = [1 if v["winner"] == "parent" else 0 for v in verdicts]
            log(f"candidate {candidate}: {why}")
        session.record_evaluation(candidate, {
            "metrics": {"matched": sum(c_scores), "cases": len(ids), "mean": sum(c_scores) / len(ids)},
            "cases": case_rows,
            "artifact_paths": [str(cand_tsv)],
            "provenance": "scripts/lca-e2e-data.sh, same questions as the parent evaluation" + ("" if protocol == "ground_truth" else f"; {JUDGE} verdicts"),
            "gate_input": gate_input,
        }, role="candidate")
        if accept:
            new_version = session.accept()
            # EvoOntology's accept publishes AND activates; activation is the human's call here (PR gate).
            SemanticStore.set_active(str(workspace), parent)
            proposal = run_dir / "proposal.md"
            proposal.write_text(proposal_text(session.run_id, parent, new_version, candidate, summary, ids, p_scores, c_scores, qs), encoding="utf-8")
            log(f"ACCEPTED: published {new_version} (active stays {parent}); proposal: {proposal}")
            log(f"approve with: python3 scripts/lca-evo-evolve.py --workspace {workspace} --activate {new_version}")
            return 0
        session.record_round(decision="reject", metrics={"parent": sum(p_scores), "candidate": sum(c_scores)}, notes=why)
        log(f"round {rnd}: REJECT ({why})")
        previous = {"hypothesis": summary["hypothesis"], "result": why}
    if session.status == "running":
        try:
            session.mark_incomplete("budget_exhausted")
        except Exception:
            session.begin_round("(budget check)", "")  # exhausts the budget -> marks incomplete
    log(f"run {session.run_id} ended: {session.status} (no candidate beat the parent)")
    return 1


def proposal_text(run_id, parent, new_version, candidate, summary, ids, p_scores, c_scores, qs) -> str:
    lines = [f"# Ontology evolution proposal — {run_id}", "", f"- parent: `{parent}` ({sum(p_scores)}/{len(ids)})", f"- candidate: `{candidate}` -> published as `{new_version}` ({sum(c_scores)}/{len(ids)})",
             f"- hypothesis: {summary['hypothesis']}", "- active.json unchanged; approve with `python3 scripts/lca-evo-evolve.py --activate " + new_version + "`", "", "## Patch", ""]
    for tid, al in summary["aliases"].items():
        lines.append(f"- aliases on `{tid}`: {', '.join(al)}")
    for tid in summary["terms"]:
        lines.append(f"- new term `{tid}`")
    for cid in summary["constraints"]:
        lines.append(f"- new constraint `{cid}`")
    lines += ["", "## Cases", "", "| id | parent | candidate | question |", "|---|---|---|---|"]
    for i, a, b in zip(ids, p_scores, c_scores):
        lines.append(f"| {i} | {a} | {b} | {qs[i]['question']} |")
    return "\n".join(lines) + "\n"


def activate(args) -> int:
    fixture = Path(args.fixture).resolve()
    workspace = Path(args.workspace or (fixture / ".evoontology")).resolve()
    v = validate(str(workspace), version=args.activate)
    if not v["passed"]:
        log(f"refusing: {args.activate} does not validate: {v['errors'][:3]}")
        return 2
    before = SemanticStore.active_version(str(workspace))
    SemanticStore.set_active(str(workspace), args.activate)
    log(f"active: {before} -> {args.activate}")
    return 0


# ------------------------------------------------------------------ self test

def self_test() -> int:
    base = {"terms": [{"id": "t-a", "name": "농장", "type": "entity", "definition": "x", "scope": "s", "aliases": ["farm"], "evidence": []}], "mappings": [{"id": "m-a", "term_id": "t-a"}], "relations": [], "constraints": [], "evidence": []}
    new, s = apply_patch(base, parse_patch('```json\n{"hypothesis":"h","aliases":[{"term_id":"t-a","add":["농장 수","farm","농장수"]}],"terms":[{"id":"t-b","name":"오리","type":"entity","definition":"duck","aliases":["duck"]}],"constraints":[{"id":"c-x","target":"t-b","constraint_type":"convention","trigger_keywords":["반경"],"description":"rule"}]}\n```'))
    assert s["aliases"] == {"t-a": ["농장 수", "농장수"]}, s
    assert s["terms"] == ["t-b"] and s["constraints"] == ["c-x"]
    assert new["terms"][1]["scope"] == "s" and new["terms"][1]["evidence"] == []
    assert base["terms"][0]["aliases"] == ["farm"], "input mutated"
    for bad, msg in [
        ('{"aliases":[{"term_id":"t-zzz","add":["x"]}]}', "unknown term_id"),
        ('{"terms":[{"id":"t-a","name":"renamed","definition":"d","aliases":["farm"]}]}', "empty patch"),
        ('{"terms":[{"id":"bad id","name":"n","definition":"d"}]}', "bad id"),
        ('{"terms":[{"id":"t-c","name":"farm","definition":"d"}]}', "already names"),
        ('{"constraints":[{"id":"c-y","target":"t-nope","trigger_keywords":["k"],"description":"d"}]}', "not a term"),
        ('{"constraints":[{"id":"c-y","target":"m-a","trigger_keywords":[],"description":"d"}]}', "trigger_keywords required"),
        ('{"aliases":[{"term_id":"t-a","add":["farm"]}]}', "empty patch"),
        ('not json at all', "no JSON object"),
    ]:
        try:
            apply_patch(base, parse_patch(bad))
        except PatchError as e:
            assert msg in str(e), (bad, str(e))
        else:
            raise AssertionError(f"accepted bad patch: {bad}")
    p = evolver_prompt(base, [{"question": "q?", "unresolved": ["오리"], "sql": "SELECT 1", "note": "wrong"}], {"hypothesis": "h0", "result": "r0"})
    new2, s2 = apply_patch(base, {"terms": [{"id": "t-a", "name": "renamed", "definition": "d", "aliases": ["농장수", "farm"]}]})
    assert s2["aliases"] == {"t-a": ["농장수"]} and new2["terms"][0]["name"] == "농장", s2
    assert "t-a | 농장 | farm" in p and "Unresolved mentions: 오리" in p and "Previous round hypothesis: h0" in p
    j = parse_judgment('```json\n{"winner": "b", "critical_error": "A", "reason": "A counts vehicles"}\n```')
    assert j == {"winner": "B", "critical_error": "A", "reason": "A counts vehicles"}, j
    assert parse_judgment("no idea")["winner"] == "tie"
    ab = EvaluationGate.anonymize({"sql": "P"}, {"sql": "C"}, swap=True)
    d = EvaluationGate.decode(j, ab)
    assert d["winner"] == "parent" and d["critical_error"] is True, d
    assert "Answer A:\nSQL: C" in judge_prompt("q", ab["A"], ab["B"])
    assert "Domain conventions" in judge_prompt("q", ab["A"], ab["B"], "- rule")
    replies = iter(['{"winner":"B","critical_error":null}', '{"winner":"A","critical_error":null}'])  # pass1 A=parent -> B=candidate; pass2 swapped A=candidate
    r = judge_twice("q", {"sql": "P"}, {"sql": "C"}, "", lambda _p: next(replies))
    assert r["winner"] == "candidate" and r["critical_error"] is False, r
    replies = iter(['{"winner":"A"}', '{"winner":"A","critical_error":"A"}'])  # pass1 parent wins, pass2 candidate wins + critical -> tie, critical
    r = judge_twice("q", {"sql": "P"}, {"sql": "C"}, "", lambda _p: next(replies))
    assert r["winner"] == "tie" and r["critical_error"] is True and r["reason"].startswith("passes disagree"), r
    assert conventions_text({"constraints": [{"description": "d1", "severity": "warn"}, {"description": "skip", "severity": "info"}]}) == "- d1"
    assert case_failed({"match": -1, "unresolved": ["x"], "note": "", "rows": {"rows": [[1]]}}) and not case_failed({"match": -1, "unresolved": [], "note": "no ground truth (rows captured)", "rows": {"rows": [[1]]}})
    print("self-test ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fixture", default=str(ROOT / "scripts" / "fixtures" / "data-vv"))
    ap.add_argument("--workspace", default="", help="EvoOntology workspace (default <fixture>/.evoontology)")
    ap.add_argument("--scratch", default=os.environ.get("LCA_E2E_SCRATCH", "~/.cache/lca/e2e"))
    ap.add_argument("--questions", default="", help="question file (jsonl); default <fixture>/queries.jsonl")
    ap.add_argument("--protocol", choices=["ground_truth", "llm_judge"], default="", help="default: ground_truth when every question has `expected`, else llm_judge")
    ap.add_argument("--no-ground-truth", action="store_true", help="strip `expected` from the questions (exercise the llm_judge path on the fixture)")
    ap.add_argument("--tier", type=int, default=2)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--model-timeout", type=int, default=600)
    ap.add_argument("--force", action="store_true", help="propose even when every case matched")
    ap.add_argument("--dry-run", action="store_true", help="parent evaluation + print the evolver prompt; no proposal")
    ap.add_argument("--activate", default="", help="human approval: set active.json to this published version")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if a.activate:
        return activate(a)
    return evolve(a)


if __name__ == "__main__":
    sys.exit(main())
