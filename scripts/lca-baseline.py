#!/usr/bin/env python3
"""lca-baseline: per-session prefix / cache-miss / compaction / repeat metrics from OpenCode's SQLite DB.

Stage-0 tooling for the lca framework (docs/agent-framework-review-2026-09-22.md, section 6).
Reads ~/.local/share/opencode/opencode.db strictly READ-ONLY (sqlite URI ?mode=ro). Stdlib only.

Schema notes (OpenCode 1.18.x, verified 2026-09-22):
  session(id, parent_id, title, agent, model(json), directory, time_created, time_updated, tokens_*)
  message(id, session_id, time_created, data(json))
      data.role            user | assistant
      data.agent           agent name; "compaction" for compaction summaries
      data.summary         true on the assistant message that is a compaction summary
      data.tokens          {input, output, reasoning, cache:{read, write}}   (assistant only)
      data.finish          stop | tool-calls | length | null(error)
      data.modelID / providerID, data.time {created, completed}, data.error
  part(id, message_id, session_id, time_created, data(json))
      data.type            step-start | step-finish | text | reasoning | tool | patch | compaction
      tool parts:          data.tool, data.state {status, input, output, ...}
      compaction parts:    on the USER message that triggered compaction: {auto, overflow, tail_start_id}

Definitions used here:
  prefix        first assistant call's tokens.input + tokens.cache.read (what the model had to have
                in context before answering the first time; cache.read is 0 for a fresh root session)
  cache_miss    assistant call with tokens.cache.read == 0 and tokens.input > 0 (full prefill)
  compaction    assistant messages with summary == true  (cross-checked against compaction parts)
  length_stops  finish == "length" (hit the output limit)
  reasoning_parts  message parts of type "reasoning" (Ollama reports tokens.reasoning=0, so parts are the signal)
  dup           identical (tool, args-JSON) calls repeated with NO write/edit/patch call in between (a re-run
                after an edit is legitimate); the stage-1 symptom was 13 identical writes in a row
  run           longest streak of consecutive identical (tool, args-JSON) calls

Usage:
  scripts/lca-baseline.py [--db PATH] [--since YYYY-MM-DD] [--top N] [--json]
  scripts/lca-baseline.py --session <id or prefix>          # adds a per-call timeline
"""

import argparse
import collections
import datetime as dt
import json
import os
import pathlib
import sqlite3
import statistics
import sys

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")


# ----------------------------------------------------------------------------- db access


def open_ro(path):
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        sys.exit(f"error: database not found: {p}")
    uri = p.as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.execute("select 1 from session limit 1")
    except sqlite3.Error as e:
        sys.exit(f"error: cannot open {p} read-only: {e}")
    return conn


def jload(s):
    try:
        return json.loads(s)
    except Exception:
        return {}


def load_sessions(conn, since_ms=None, prefix=None):
    q = "select id, parent_id, title, agent, model, directory, time_created, time_updated from session"
    conds, args = [], []
    if since_ms is not None:
        conds.append("time_created >= ?")
        args.append(since_ms)
    if prefix:
        conds.append("(id = ? or id like ?)")
        args += [prefix, prefix + "%"]
    if conds:
        q += " where " + " and ".join(conds)
    q += " order by time_created desc"
    return conn.execute(q, args).fetchall()


# ----------------------------------------------------------------------------- analysis


def analyze(conn, row):
    sid, parent_id, title, agent, model_json, directory, t_created, t_updated = row
    msgs = conn.execute(
        "select id, time_created, data from message where session_id=? order by time_created, id", (sid,)
    ).fetchall()
    parts = collections.defaultdict(list)
    for mid, d in conn.execute(
        "select message_id, data from part where session_id=? order by time_created, id", (sid,)
    ):
        parts[mid].append(jload(d))

    timeline = []
    n_user = n_assistant = n_compaction = n_tool = n_tool_err = n_api_err = 0
    compaction_parts = 0
    first_input = first_cache = None
    cache_miss_calls = cache_miss_tokens = length_stops = 0
    reasoning_parts = reasoning_chars = 0
    write_calls = 0  # write/edit/patch tool calls (a delegating main should have none)
    tot_in = tot_cr = tot_cw = tot_out = tot_reason = 0
    t_first = t_last = None
    agents = collections.Counter()
    models = collections.Counter()
    call_seq = []  # (tool, args_json) in order

    for mid, tc, d in msgs:
        j = jload(d)
        role = j.get("role")
        tm = j.get("time") or {}
        created = tm.get("created") or tc
        completed = tm.get("completed") or created
        t_first = created if t_first is None else min(t_first, created)
        t_last = completed if t_last is None else max(t_last, completed)
        if role == "user":
            n_user += 1
            compaction_parts += sum(1 for p in parts[mid] if p.get("type") == "compaction")
            continue
        if role != "assistant":
            continue
        tokens = j.get("tokens") or {}
        cache = tokens.get("cache") or {}
        inp = int(tokens.get("input") or 0)
        cr = int(cache.get("read") or 0)
        cw = int(cache.get("write") or 0)
        out = int(tokens.get("output") or 0)
        rsn = int(tokens.get("reasoning") or 0)
        is_summary = bool(j.get("summary")) or j.get("agent") == "compaction"
        tools = []
        for p in parts[mid]:
            if p.get("type") == "reasoning":
                reasoning_parts += 1
                reasoning_chars += len(p.get("text") or "")
            if p.get("type") != "tool":
                continue
            st = p.get("state") or {}
            args = json.dumps(st.get("input"), sort_keys=True, ensure_ascii=False)
            tools.append({"tool": p.get("tool"), "args": args, "status": st.get("status")})
        entry = {
            "message_id": mid,
            "t_offset_s": None,  # filled below
            "created": created,
            "completed": completed,
            "agent": j.get("agent"),
            "model": j.get("modelID"),
            "input": inp,
            "cache_read": cr,
            "cache_write": cw,
            "output": out,
            "reasoning": rsn,
            "finish": j.get("finish"),
            "summary": is_summary,
            "error": (j.get("error") or {}).get("name") if j.get("error") else None,
            "tools": tools,
        }
        timeline.append(entry)
        tot_in += inp
        tot_cr += cr
        tot_cw += cw
        tot_out += out
        tot_reason += rsn
        if j.get("error"):
            n_api_err += 1
        if is_summary:
            n_compaction += 1
            continue
        n_assistant += 1
        agents[j.get("agent")] += 1
        models[j.get("modelID")] += 1
        if first_input is None and (inp + cr) > 0:
            first_input, first_cache = inp, cr
        if inp > 0 and cr == 0:
            cache_miss_calls += 1
            cache_miss_tokens += inp
        if j.get("finish") == "length":
            length_stops += 1
        write_calls += sum(1 for t in tools if t["tool"] in ("write", "edit", "patch", "multiedit"))
        for t in tools:
            n_tool += 1
            if t["status"] == "error":
                n_tool_err += 1
            call_seq.append((t["tool"], t["args"]))

    # repeated identical calls: an identical (tool, args) call counts as wasted only when nothing changed the working
    # tree in between (a test command re-run after an edit is legitimate, not a doom loop)
    MUTATING = {"write", "edit", "patch", "multiedit"}
    seen = set()
    dup_total = 0
    for c in call_seq:
        if c[0] in MUTATING:
            seen = set()
        if c in seen:
            dup_total += 1
        seen.add(c)
    max_run, run, prev, max_run_tool = 0, 0, None, None
    for c in call_seq:
        run = run + 1 if c == prev else 1
        prev = c
        if run > max_run:
            max_run, max_run_tool = run, c[0]
    # longest streak of the same tool regardless of args (the "13 writes" symptom)
    max_tool_run, run, prev, max_tool_run_tool = 0, 0, None, None
    for c in call_seq:
        run = run + 1 if c[0] == prev else 1
        prev = c[0]
        if run > max_tool_run:
            max_tool_run, max_tool_run_tool = run, c[0]

    base = t_first or t_created
    for e in timeline:
        e["t_offset_s"] = round((e["created"] - base) / 1000, 1)

    try:
        model = jload(model_json).get("id") if model_json else None
    except Exception:
        model = None
    main_agent = agent or (agents.most_common(1)[0][0] if agents else None)
    wall_s = round(((t_last or t_created) - (t_first or t_created)) / 1000, 1)

    return {
        "id": sid,
        "short": sid.replace("ses_", "")[:10],
        "parent_id": parent_id,
        "kind": "child" if parent_id else "root",
        "title": title or "",
        "agent": main_agent,
        "model": model or (models.most_common(1)[0][0] if models else None),
        "directory": directory,
        "time_created": t_created,
        "started": dt.datetime.fromtimestamp(t_created / 1000).strftime("%Y-%m-%d %H:%M"),
        "n_user_msgs": n_user,
        "n_assistant_msgs": n_assistant,
        "n_tool_calls": n_tool,
        "n_tool_errors": n_tool_err,
        "n_api_errors": n_api_err,
        "first_call_input_tokens": first_input,
        "first_call_cache_read": first_cache,
        "prefix_tokens": (first_input or 0) + (first_cache or 0) if first_input is not None else None,
        "cache_miss_calls": cache_miss_calls,
        "cache_miss_tokens": cache_miss_tokens,
        "compaction_count": n_compaction,
        "compaction_parts": compaction_parts,
        "length_stops": length_stops,
        "reasoning_parts": reasoning_parts,
        "reasoning_chars": reasoning_chars,
        "write_calls": write_calls,
        "repeated_identical_tool_calls": dup_total,
        "max_identical_run": max_run,
        "max_identical_run_tool": max_run_tool,
        "max_same_tool_run": max_tool_run,
        "max_same_tool_run_tool": max_tool_run_tool,
        "total_input": tot_in,
        "total_cache_read": tot_cr,
        "total_cache_write": tot_cw,
        "total_output": tot_out,
        "total_reasoning": tot_reason,
        "wall_s": wall_s,
        "timeline": timeline,
    }


def summarize(rows):
    by_agent = collections.defaultdict(list)
    for r in rows:
        if r["prefix_tokens"]:
            by_agent[r["agent"]].append(r["prefix_tokens"])
    agent_prefix = {
        a: {"n": len(v), "median": int(statistics.median(v)), "min": min(v), "max": max(v)}
        for a, v in sorted(by_agent.items(), key=lambda kv: -len(kv[1]))
    }
    return {
        "sessions": len(rows),
        "root_sessions": sum(1 for r in rows if r["kind"] == "root"),
        "child_sessions": sum(1 for r in rows if r["kind"] == "child"),
        "assistant_msgs": sum(r["n_assistant_msgs"] for r in rows),
        "tool_calls": sum(r["n_tool_calls"] for r in rows),
        "tool_errors": sum(r["n_tool_errors"] for r in rows),
        "cache_miss_calls": sum(r["cache_miss_calls"] for r in rows),
        "cache_miss_tokens": sum(r["cache_miss_tokens"] for r in rows),
        "compactions": sum(r["compaction_count"] for r in rows),
        "length_stops": sum(r["length_stops"] for r in rows),
        "reasoning_parts": sum(r["reasoning_parts"] for r in rows),
        "repeated_identical_tool_calls": sum(r["repeated_identical_tool_calls"] for r in rows),
        "sessions_with_repeats": sum(1 for r in rows if r["repeated_identical_tool_calls"] > 0),
        "total_input": sum(r["total_input"] for r in rows),
        "total_cache_read": sum(r["total_cache_read"] for r in rows),
        "total_output": sum(r["total_output"] for r in rows),
        "wall_s": round(sum(r["wall_s"] for r in rows), 1),
        "prefix_by_agent": agent_prefix,
    }


# ----------------------------------------------------------------------------- output


def k(n):
    if n is None:
        return "-"
    n = int(n)
    if n >= 10000:
        return f"{n/1000:.1f}K"
    return str(n)


def trunc(s, n):
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def print_table(rows):
    hdr = (
        f"{'session':10} {'started':16} {'title':30} {'agent':14} {'model':16} {'K':1} {'amsg':>4} {'tool':>4} "
        f"{'prefix':>7} {'miss':>4} {'comp':>4} {'len':>3} {'dup':>3} {'run':>3} {'in':>7} {'cread':>7} {'out':>6} {'wall':>7}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['short']:10} {r['started']:16} {trunc(r['title'],30):30} {trunc(r['agent'],14):14} "
            f"{trunc(r['model'],16):16} {('C' if r['kind']=='child' else 'R'):1} {r['n_assistant_msgs']:>4} {r['n_tool_calls']:>4} "
            f"{k(r['prefix_tokens']):>7} {r['cache_miss_calls']:>4} {r['compaction_count']:>4} {r['length_stops']:>3} "
            f"{r['repeated_identical_tool_calls']:>3} {r['max_identical_run']:>3} {k(r['total_input']):>7} "
            f"{k(r['total_cache_read']):>7} {k(r['total_output']):>6} {r['wall_s']:>7.0f}"
        )
    print()
    print(
        "K=R root/C child  amsg=assistant msgs  prefix=first call input+cache_read  miss=cache-miss calls  "
        "comp=compactions  len=finish=length  dup=repeated identical calls  run=longest identical streak  wall=seconds"
    )


def print_summary(s):
    print()
    print("== summary ==")
    print(
        f"sessions {s['sessions']} (root {s['root_sessions']}, child {s['child_sessions']})  "
        f"assistant msgs {s['assistant_msgs']}  tool calls {s['tool_calls']} (errors {s['tool_errors']})"
    )
    print(
        f"cache-miss calls {s['cache_miss_calls']} ({k(s['cache_miss_tokens'])} tokens prefilled)  "
        f"compactions {s['compactions']}  length stops {s['length_stops']}  "
        f"repeated identical calls {s['repeated_identical_tool_calls']} in {s['sessions_with_repeats']} sessions"
    )
    print(
        f"tokens: input {k(s['total_input'])}  cache_read {k(s['total_cache_read'])}  output {k(s['total_output'])}  "
        f"wall {s['wall_s']/60:.1f} min"
    )
    if s["prefix_by_agent"]:
        print("prefix (first call) by agent, median [min..max] over n sessions:")
        for a, v in s["prefix_by_agent"].items():
            print(f"  {trunc(a,24):24} {k(v['median']):>7} [{k(v['min'])}..{k(v['max'])}]  n={v['n']}")


def print_timeline(r):
    print()
    print(f"== timeline {r['id']}  \"{trunc(r['title'],60)}\"  agent={r['agent']} model={r['model']}")
    print(f"{'#':>3} {'t+s':>7} {'agent':16} {'in':>7} {'cread':>7} {'out':>6} {'finish':10} tools")
    prev = None
    for i, e in enumerate(r["timeline"], 1):
        names = []
        for t in e["tools"]:
            key = (t["tool"], t["args"])
            mark = "!" if t["status"] == "error" else ""
            rep = "=" if key == prev else ""
            names.append(f"{rep}{t['tool']}{mark}")
            prev = key
        tag = " [compaction]" if e["summary"] else ""
        err = f" [{e['error']}]" if e["error"] else ""
        print(
            f"{i:>3} {e['t_offset_s']:>7.0f} {trunc(e['agent'],16):16} {e['input']:>7} {e['cache_read']:>7} "
            f"{e['output']:>6} {str(e['finish']):10} {' '.join(names)}{tag}{err}"
        )
    print("legend: '!' tool error, '=' identical (tool,args) to the previous call")


# ----------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB, help=f"sqlite path (default {DEFAULT_DB})")
    ap.add_argument("--since", help="only sessions created on/after YYYY-MM-DD (local time)")
    ap.add_argument("--session", help="session id or prefix; prints a per-call timeline")
    ap.add_argument("--top", type=int, default=0, help="only the N newest sessions (0 = all)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args()

    since_ms = None
    if a.since:
        try:
            since_ms = int(dt.datetime.strptime(a.since, "%Y-%m-%d").timestamp() * 1000)
        except ValueError:
            sys.exit("error: --since expects YYYY-MM-DD")

    conn = open_ro(a.db)
    sessions = load_sessions(conn, since_ms, a.session)
    if a.top and a.top > 0:
        sessions = sessions[: a.top]
    rows = [analyze(conn, s) for s in sessions]
    summary = summarize(rows)

    if a.json:
        out = {"db": str(pathlib.Path(a.db).expanduser().resolve()), "summary": summary, "sessions": []}
        for r in rows:
            r2 = dict(r)
            if not a.session:
                r2.pop("timeline")
            out["sessions"].append(r2)
        json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return

    print(f"db: {a.db}  sessions: {len(rows)}" + (f"  since: {a.since}" if a.since else ""))
    if not rows:
        print("(no sessions)")
        return
    print_table(rows)
    print_summary(summary)
    if a.session:
        for r in rows:
            print_timeline(r)


if __name__ == "__main__":
    main()
