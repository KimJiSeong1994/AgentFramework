#!/usr/bin/env python3
"""Isolated actual-host skill acceptance probes. Every result is synthetic, never production evidence.

Called by otter-e2e.sh after its XDG isolation and fixture setup. Raw OpenCode CLI output is kept
only in the scratch log directory; receipts contain bounded, sanitized metadata and fingerprints.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

FIXTURE_SKILL = "observation-fixture"
MISSING_SKILL = "missing-observation-fixture"
SCENARIOS = ("main", "missing-skill", "advice-only", "worker-denied", "worker-allowed", "verify-failure")
ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
MAX_API_BODY = 1024 * 1024


class ProbeFailure(Exception):
    def __init__(self, code, status="failed"):
        super().__init__(code)
        self.code = code
        self.status = status


def require(condition, code, status="failed"):
    if not condition:
        raise ProbeFailure(code, status)


def valid_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= 200
            and value[0].isalnum() and all(char in ID_CHARS for char in value))


def scratch_env(work):
    # OpenCode receives only runtime/isolation variables, never caller credentials or server auth.
    allowed = ("PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
               "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        if key in env:
            env[key] = str(Path(env[key]).resolve())
    for key in ("OPENCODE_CONFIG_DIR", "ORCA_OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG",
                "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
                "OTTER_STATE_HOME"):
        env.pop(key, None)
    isolated_home = Path(env["XDG_CONFIG_HOME"]).resolve().parent / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    env["HOME"] = str(isolated_home)
    env["PWD"] = str(work.resolve())
    return env


def signal_process_group(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            proc.send_signal(sig)
        except OSError:
            pass


def stop_process(proc):
    if proc is None or proc.poll() is not None:
        return True
    signal_process_group(proc, signal.SIGTERM)
    try:
        proc.wait(timeout=3)
        return True
    except subprocess.TimeoutExpired:
        signal_process_group(proc, signal.SIGKILL)
        try:
            proc.wait(timeout=3)
            return True
        except subprocess.TimeoutExpired:
            return False


def run_logged(argv, work, env, timeout, stdout_path, stderr_path):
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("w", encoding="utf-8") as out, stderr_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(argv, cwd=str(work), env=env, stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err, start_new_session=True)
        try:
            return {"returnCode": proc.wait(timeout=timeout), "timedOut": False}
        except subprocess.TimeoutExpired:
            cleaned = stop_process(proc)
            return {"returnCode": proc.poll(), "timedOut": True, "cleanupComplete": cleaned}
        finally:
            if proc.poll() is None:
                stop_process(proc)


def run_control(argv, work, env, timeout=15):
    try:
        return subprocess.run(argv, cwd=str(work), env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise ProbeFailure("control_command_timeout") from error


def configure_scenario(work, scenario, observer=None, router_endpoint=None):
    config_path = work / ".otter" / "otter.jsonc"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if scenario == "missing-skill":
        skills = config.setdefault("skills", {}).setdefault("allow", [])
        if MISSING_SKILL not in skills:
            skills.append(MISSING_SKILL)
    if scenario == "advice-only":
        config["skill_router"] = {"mode": "suggest", "endpoint": router_endpoint, "timeout_ms": 1000}
        config["memory"] = {**config.get("memory", {}), "engine": "jev"}
    if scenario == "verify-failure":
        config["disabled_hooks"] = [hook for hook in config.get("disabled_hooks", [])
                                    if hook not in ("tool.delegate", "loop.idle")]
        config["delegate"] = {"review": False, "max_attempts": 1, "worktree": False}
    if observer is not None:
        config["skill_observation"] = {
            "enabled": True,
            "campaign_id": observer["campaignID"],
            "owner_root": str(work.resolve()),
            "owner_binding": observer["ownerBinding"],
        }
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if scenario in ("worker-allowed", "verify-failure"):
        override = work / ".opencode" / "opencode.jsonc"
        require(not override.exists(), "unexpected_scratch_agent_config")
        override.write_text(json.dumps({"agent": {"worker": {"permission": {"skill": {
            "*": "deny", FIXTURE_SKILL: "allow",
        }}}}}, indent=2) + "\n", encoding="utf-8")
    if scenario == "verify-failure":
        skill_file = work / ".opencode" / "skills" / FIXTURE_SKILL / "SKILL.md"
        skill_text = skill_file.read_text(encoding="utf-8")
        original_instruction = ("After loading this skill, reply with exactly: OBSERVATION_FIXTURE_LOADED\n"
                                "Do not run other tools or modify files.")
        scenario_instruction = ("After loading this skill, create worker-result.txt containing exactly: "
                                "OBSERVATION_FIXTURE_LOADED. After writing it, do not run other tools or "
                                "modify files.")
        require(skill_text.count(original_instruction) == 1, "synthetic_skill_fixture_unexpected")
        skill_file.write_text(skill_text.replace(original_instruction, scenario_instruction, 1), encoding="utf-8")
        verifier = work / "verify.sh"
        require(not verifier.exists(), "unexpected_verify_fixture")
        verifier.write_text("#!/bin/sh\nexit 2\n", encoding="utf-8")
        verifier.chmod(0o755)


def parse_jsonl_sessions(path):
    sessions = set()
    if not path.exists():
        return sessions
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            session_id = event.get("sessionID") if isinstance(event, dict) else None
            if valid_id(session_id):
                sessions.add(session_id)
    return sessions


def host_skill_parts(db_path, session_ids, expected_name):
    if not Path(db_path).is_file():
        raise ProbeFailure("host_database_unavailable", "unsupported")
    rows = []
    if not session_ids:
        return rows
    with sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True) as db:
        for session_id in sorted(session_ids):
            for raw, message_id, message_raw in db.execute(
                    "SELECT p.data, p.message_id, m.data FROM part p JOIN message m ON m.id=p.message_id WHERE p.session_id=?",
                    (session_id,)):
                part = json.loads(raw)
                if not isinstance(part, dict) or part.get("type") != "tool" or part.get("tool") != "skill":
                    continue
                state = part.get("state") if isinstance(part.get("state"), dict) else {}
                args = state.get("input") if isinstance(state.get("input"), dict) else {}
                metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
                message = json.loads(message_raw) if message_raw else {}
                if not isinstance(message, dict):
                    message = {}
                output = state.get("output") if isinstance(state.get("output"), str) else ""
                status = state.get("status")
                if status not in ("pending", "running", "completed", "error"):
                    status = "unknown"
                requested = args.get("name")
                returned = metadata.get("name")
                stable_body_hash = None
                expected_return_name = expected_name
                body_prefix = f'<skill_content name="{expected_return_name}">\n# Skill: {expected_return_name}\n\n'
                body_delimiter = "\n\nBase directory for this skill: "
                if output.startswith(body_prefix):
                    body_start = len(body_prefix)
                    delimiter_at = output.find(body_delimiter, body_start)
                    if delimiter_at >= body_start and output.find(body_delimiter, delimiter_at + len(body_delimiter)) < 0:
                        stable_body_hash = hashlib.sha256(output[body_start:delimiter_at].encode()).hexdigest()
                rows.append({
                    "sessionID": session_id,
                    "status": status,
                    "requestedName": requested if requested in (FIXTURE_SKILL, MISSING_SKILL) else None,
                    "requestedNameMatchesExpected": requested == expected_name,
                    "returnedName": returned if returned in (FIXTURE_SKILL, MISSING_SKILL) else None,
                    "hasDirectoryMetadata": isinstance(metadata.get("dir"), str),
                    "hasCallID": valid_id(part.get("callID")),
                    "callID": part.get("callID") if valid_id(part.get("callID")) else None,
                    "hasMessageID": valid_id(message_id),
                    "messageID": message_id if valid_id(message_id) else None,
                    "hasAssistantParent": valid_id(message.get("parentID")),
                    "parentMessageID": message.get("parentID") if valid_id(message.get("parentID")) else None,
                    "hasActualAgent": isinstance(message.get("agent"), str),
                    "actualAgent": message.get("agent") if message.get("agent") in ("main", "worker", "reviewer") else None,
                    "hasSkillWrapper": output.startswith(f'<skill_content name="{FIXTURE_SKILL}">') and output.rstrip().endswith("</skill_content>"),
                    "hasTruncationMetadata": isinstance(metadata.get("truncated"), bool),
                    "payloadSha256": hashlib.sha256(output.encode()).hexdigest(),
                    "stableReturnedBodySha256": stable_body_hash,
                    "stableReturnedBodyBasis": "opencode-1.18.33.trimmed-content.v1" if stable_body_hash else None,
                    "containsFixtureInstruction": "OBSERVATION_FIXTURE_LOADED" in output,
                    "hasErrorDetails": "error" in state,
                    "loadedOriginalFileSha256": None,
                })
    return rows


def observation_data(db_path, session_ids=None):
    if not Path(db_path).is_file():
        raise ProbeFailure("observer_database_unavailable")
    facts = []
    with sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True) as db:
        def read_facts(rows):
            for kind, phase, conflict, payload in rows:
                fact = json.loads(payload)
                fact["kind"] = kind
                fact["phase"] = phase
                fact["conflict"] = bool(conflict)
                facts.append(fact)

        if session_ids is None:
            read_facts(db.execute("SELECT kind, phase, conflict, payload_json FROM facts"))
        else:
            for session_id in sorted(session_ids):
                read_facts(db.execute("SELECT kind, phase, conflict, payload_json FROM facts WHERE session_id=?",
                                      (session_id,)))
        campaign = db.execute("SELECT status, session_count, call_count FROM campaigns WHERE singleton=1").fetchone()
    if not campaign:
        raise ProbeFailure("observer_campaign_unavailable")
    return facts, {"status": campaign[0], "sessionCount": campaign[1], "callCount": campaign[2]}


def router_facts(facts, session_ids):
    turns = [fact for fact in facts if fact.get("kind") == "turn_context"
             and fact.get("sessionID") in session_ids]
    advice = [fact for fact in turns if fact.get("adviceInserted") is True
              and fact.get("routeSkillName") == FIXTURE_SKILL
              and isinstance(fact.get("routeDecisionID"), str)]
    worker = [fact for fact in turns if fact.get("actualAgent") == "worker"
              and fact.get("agentBasis") == "sdk_agent_field"]
    return {
        "turnFactCount": len(turns),
        "adviceTurnCount": len(advice),
        "adviceTurnEvidence": [{"sessionID": fact.get("sessionID"), "routeSkillName": FIXTURE_SKILL,
                                 "adviceInserted": True, "hasDecisionID": True} for fact in advice[:1]],
        "workerTurnCount": len(worker),
        "workerTurnEvidence": [{"sessionID": fact.get("sessionID"), "actualAgent": "worker",
                                 "agentBasis": "sdk_agent_field"} for fact in worker[:1]],
    }


def call_facts(facts, session_ids):
    return [fact for fact in facts if fact.get("kind") == "skill_call"
            and fact.get("sessionID") in session_ids]


def validate_recorded_load(facts, session_ids, expected_state):
    recorded = call_facts(facts, session_ids)
    require(len(recorded) == 1 and recorded[0].get("state") == expected_state
            and recorded[0].get("phase") == "terminal" and recorded[0].get("conflict") is False,
            "observer_skill_call_mismatch")
    if expected_state == "completed":
        require(recorded[0].get("returnedBodySha256") and recorded[0].get("observedFileSha256"),
                "observer_fingerprints_missing")
        require(recorded[0].get("loadedOriginalFileSha256") is None,
                "original_loaded_bytes_must_remain_unavailable")
    return recorded


def host_owner_session(db_path, candidate_sessions, marker):
    owners = set()
    with sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True) as db:
        for session_id in sorted(candidate_sessions):
            for message_raw, part_raw in db.execute(
                    "SELECT m.data, p.data FROM part p JOIN message m ON m.id=p.message_id WHERE p.session_id=?",
                    (session_id,)):
                message = json.loads(message_raw)
                part = json.loads(part_raw)
                if (message.get("role") == "user" and isinstance(part, dict) and part.get("type") == "text"
                        and marker in (part.get("text") or "")):
                    owners.add(session_id)
    require(len(owners) == 1, "owner_session_identity_unavailable", "unsupported")
    return next(iter(owners))


def read_verify_failure_ledger(work, owner_session_id):
    work_key = hashlib.sha1(str(work.resolve()).encode()).hexdigest()[:12]
    ledger_path = Path(os.environ["XDG_STATE_HOME"]) / "otter" / work_key / "sessions" / owner_session_id / "ledger.json"
    if not ledger_path.is_file():
        raise ProbeFailure("owner_task_ledger_unavailable", "unsupported")
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProbeFailure("owner_task_ledger_invalid", "unsupported") from error
    require(isinstance(ledger, dict) and ledger.get("sessionID") == owner_session_id,
            "ledger_owner_session_mismatch")
    tasks = ledger.get("tasks") if isinstance(ledger, dict) else None
    require(isinstance(tasks, list) and len(tasks) == 1, "expected_one_owner_task")
    task = tasks[0]
    require(isinstance(task, dict) and task.get("status") == "failed" and task.get("attempts") == 1,
            "owner_task_not_failed_after_one_attempt")
    verify = task.get("verify_result")
    require(task.get("verify") == "bash ./verify.sh" and isinstance(verify, dict)
            and verify.get("ok") is False and verify.get("exitCode") == 2
            and verify.get("timedOut") is False and verify.get("command") == "bash ./verify.sh",
            "code_owned_queue_verifier_did_not_fail_with_exit_2")
    require(isinstance(task.get("review"), dict) and task["review"].get("verdict") == "skipped",
            "review_was_not_disabled_for_acceptance")
    child_sessions = task.get("childSessions")
    child_id = task.get("workerSessionID")
    require(valid_id(child_id) and isinstance(child_sessions, list) and child_sessions == [child_id],
            "owner_task_child_session_unavailable")
    require(valid_id(task.get("id")), "owner_task_id_unavailable")
    return task, child_id


def validate_verify_failure_facts(facts, owner_id, child_id, task_id, attempt_id, recorded_calls):
    owner_task = [fact for fact in facts if fact.get("kind") == "task_context"
                  and fact.get("sessionID") == owner_id and fact.get("taskID") == task_id
                  and fact.get("attemptID") == attempt_id]
    child_task = [fact for fact in facts if fact.get("kind") == "task_context"
                  and fact.get("sessionID") == child_id and fact.get("taskID") == task_id
                  and fact.get("attemptID") == attempt_id]
    verification = [fact for fact in facts if fact.get("kind") == "verification_observation"
                    and fact.get("sessionID") == owner_id and fact.get("taskID") == task_id
                    and fact.get("attemptID") == attempt_id]
    require(len(owner_task) == 1 and owner_task[0].get("phase") == "terminal"
            and owner_task[0].get("status") == "failed"
            and owner_task[0].get("taskStatus") == "failed"
            and owner_task[0].get("conflict") is False
            and owner_task[0].get("ownerSessionID") == owner_id,
            "owner_task_fact_mismatch")
    require(len(child_task) == 1 and child_task[0].get("phase") == "terminal"
            and child_task[0].get("status") == "done"
            and child_task[0].get("conflict") is False
            and child_task[0].get("ownerSessionID") == owner_id
            and child_task[0].get("childSessionID") == child_id
            and valid_id(child_task[0].get("childMessageID"))
            and child_task[0].get("actualRole") == "worker"
            and child_task[0].get("roleBasis") == "code_owned",
            "worker_child_task_fact_mismatch")
    require(len(verification) == 1 and verification[0].get("phase") == "terminal"
            and verification[0].get("status") == "fail"
            and verification[0].get("conflict") is False
            and verification[0].get("codeOwned") is True
            and verification[0].get("exitCode") == 2
            and verification[0].get("taskStatus") == "failed",
            "code_owned_verification_fact_mismatch")
    require(len(recorded_calls) == 1 and recorded_calls[0].get("sessionID") == child_id
            and recorded_calls[0].get("state") == "completed"
            and recorded_calls[0].get("phase") == "terminal"
            and recorded_calls[0].get("conflict") is False
            and recorded_calls[0].get("requestedName") == FIXTURE_SKILL
            and recorded_calls[0].get("returnedName") == FIXTURE_SKILL
            and recorded_calls[0].get("returnedBodySha256")
            and recorded_calls[0].get("observedFileSha256")
            and recorded_calls[0].get("loadedOriginalFileSha256") is None,
            "completed_child_skill_fact_mismatch")
    return owner_task[0], child_task[0], verification[0], recorded_calls[0]


def verify_failure_acceptance(work, host_db, observation_db, candidate_sessions, marker, config_sha256, skill_sha256):
    owner_id = host_owner_session(host_db, candidate_sessions, marker)
    task, child_id = read_verify_failure_ledger(work, owner_id)
    task_id = task["id"]
    config_path = work / ".otter" / "otter.jsonc"
    require(hashlib.sha256(config_path.read_bytes()).hexdigest() == config_sha256,
            "verify_failure_scratch_config_was_modified")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    delegate = config.get("delegate") if isinstance(config, dict) else None
    disabled_hooks = config.get("disabled_hooks") if isinstance(config, dict) else None
    require(isinstance(delegate, dict) and delegate.get("max_attempts") == 1
            and delegate.get("review") is False and delegate.get("worktree") is False
            and isinstance(disabled_hooks, list) and "tool.delegate" not in disabled_hooks,
            "verify_failure_config_invariants_missing")
    agent_config = json.loads((work / ".opencode" / "opencode.jsonc").read_text(encoding="utf-8"))
    agents = agent_config.get("agent") if isinstance(agent_config, dict) else None
    worker = agents.get("worker") if isinstance(agents, dict) else None
    skill_permission = worker.get("permission", {}).get("skill", {}) if isinstance(worker, dict) else {}
    require(skill_permission == {"*": "deny", FIXTURE_SKILL: "allow"},
            "worker_skill_override_was_not_isolated")
    skill_file = work / ".opencode" / "skills" / FIXTURE_SKILL / "SKILL.md"
    require(not skill_file.is_symlink() and hashlib.sha256(skill_file.read_bytes()).hexdigest() == skill_sha256,
            "verify_failure_scratch_skill_was_modified")
    verify_path = work / "verify.sh"
    require(verify_path.is_file() and not verify_path.is_symlink()
            and verify_path.read_text(encoding="utf-8") == "#!/bin/sh\nexit 2\n",
            "verify_fixture_was_modified")
    result_path = work / "worker-result.txt"
    require(result_path.is_file() and not result_path.is_symlink()
            and result_path.read_text(encoding="utf-8").strip() == "OBSERVATION_FIXTURE_LOADED",
            "worker_result_marker_missing", "unsupported")
    facts, campaign = observation_data(observation_db)
    owner_tasks = [fact for fact in facts if fact.get("kind") == "task_context"
                   and fact.get("sessionID") == owner_id and fact.get("taskID") == task_id
                   and fact.get("phase") == "terminal" and fact.get("status") == "failed"]
    require(len(owner_tasks) == 1 and valid_id(owner_tasks[0].get("attemptID")),
            "owner_attempt_identity_unavailable")
    attempt_id = owner_tasks[0]["attemptID"]
    recorded_calls = call_facts(facts, {child_id})
    owner_fact, child_fact, verify_fact, skill_fact = validate_verify_failure_facts(
        facts, owner_id, child_id, task_id, attempt_id, recorded_calls)
    calls = host_skill_parts(host_db, {child_id}, FIXTURE_SKILL)
    require(len(calls) == 1 and calls[0]["status"] == "completed"
            and calls[0]["requestedName"] == FIXTURE_SKILL
            and calls[0]["returnedName"] == FIXTURE_SKILL
            and calls[0]["containsFixtureInstruction"]
            and calls[0]["actualAgent"] == "worker",
            "actual_worker_skill_call_not_completed")
    require(skill_fact.get("callID") == calls[0]["callID"], "host_observation_call_id_mismatch")
    require(skill_fact.get("messageID") == calls[0]["messageID"]
            and child_fact["childMessageID"] == calls[0]["parentMessageID"],
            "host_child_prompt_lineage_mismatch")
    skill_turns = [fact for fact in facts if fact.get("kind") == "turn_context"
                   and fact.get("sessionID") == child_id
                   and fact.get("messageID") == skill_fact["messageID"]]
    require(len(skill_turns) == 1 and skill_turns[0].get("phase") == "terminal"
            and skill_turns[0].get("conflict") is False
            and skill_turns[0].get("role") == "assistant"
            and skill_turns[0].get("actualAgent") == "worker"
            and skill_turns[0].get("agentBasis") == "sdk_agent_field"
            and skill_turns[0].get("parentMessageID") == child_fact["childMessageID"],
            "exact_worker_turn_lineage_mismatch")
    require(skill_fact.get("returnedBodySha256") == calls[0]["stableReturnedBodySha256"],
            "stable_returned_body_fingerprint_mismatch")
    worker_turns = router_facts(facts, {child_id})
    require(worker_turns["workerTurnCount"] >= 1, "persisted_worker_agent_basis_unavailable", "unsupported")
    require(campaign["callCount"] == 1, "verify_failure_campaign_call_count_mismatch")
    return {
        "ownerSessionID": owner_id,
        "childSessionID": child_id,
        "childMessageID": child_fact["childMessageID"],
        "taskID": task_id,
        "attemptID": attempt_id,
        "verificationID": verify_fact["verificationID"],
        "ledger": {"taskStatus": task["status"], "attemptCount": task["attempts"],
                   "childSessionCount": len(task["childSessions"]), "verifyCommandMatchesFixture": True,
                   "verifyExitCode": task["verify_result"]["exitCode"], "reviewVerdict": task["review"]["verdict"],
                   "maxAttemptsConfigured": delegate["max_attempts"], "maxRetriesConfigured": 0,
                   "reviewEnabled": delegate["review"], "workerSkillOverrideConfigured": True,
                   "scenarioSpecificScratchSkill": True,
                   "verifyFixtureUnchanged": True},
        "actualHost": {"workerCallCount": len(calls), "workerCallStatus": calls[0]["status"],
                       "workerCallPhase": skill_fact["phase"], "workerCallConflict": skill_fact["conflict"],
                       "workerCallSessionMatchesChild": calls[0]["sessionID"] == child_id,
                       "workerAgent": calls[0]["actualAgent"],
                       "stableReturnedBodySha256": calls[0]["stableReturnedBodySha256"],
                       "payloadShaIsPathSensitive": True},
        "observationFacts": {
            "ownerTask": {"phase": owner_fact["phase"], "status": owner_fact["status"],
                          "ownerSessionMatches": owner_fact["ownerSessionID"] == owner_id},
            "workerChildTask": {"phase": child_fact["phase"], "status": child_fact["status"],
                                "ownerSessionMatches": child_fact["ownerSessionID"] == owner_id,
                                "childSessionMatches": child_fact["childSessionID"] == child_id,
                                "actualRole": child_fact["actualRole"], "roleBasis": child_fact["roleBasis"]},
            "verification": {"phase": verify_fact["phase"], "status": verify_fact["status"],
                             "codeOwned": verify_fact["codeOwned"], "exitCode": verify_fact["exitCode"],
                             "taskStatus": verify_fact["taskStatus"],
                             "taskAttemptIDsMatch": verify_fact["taskID"] == task_id
                             and verify_fact["attemptID"] == attempt_id},
            "workerTurnCount": worker_turns["workerTurnCount"],
            "skillCallExactChildTurnRelation": True,
            "skillCallDirectTaskAttemptRelation": skill_fact.get("taskRelation", "unknown"),
        },
        "recorderCampaign": campaign,
        "calls": calls,
    }


class RouterFixtureState:
    def __init__(self):
        self.requests = 0
        self.validCandidateSet = False
        self.expectedChoiceSent = False
        self.lock = threading.Lock()


class RouterFixtureHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        state = self.server.fixture_state
        try:
            self.connection.settimeout(3)
            length = int(self.headers.get("Content-Length", "0"))
            if self.path != "/v1/systemone" or length <= 0 or length > 65536:
                raise ValueError
            request_data = json.loads(self.rfile.read(length))
            criteria = request_data["questions"]["route"]["criteria"]
            if not isinstance(criteria, dict) or "none" not in criteria:
                raise ValueError
            names = set(criteria)
            valid = names == {FIXTURE_SKILL, "none"}
            choice = FIXTURE_SKILL if valid else "none"
            probabilities = {name: 0.0 for name in names}
            if valid:
                probabilities[FIXTURE_SKILL] = 0.99
                probabilities["none"] = 0.01
            else:
                probabilities["none"] = 1.0
            with state.lock:
                state.requests += 1
                state.validCandidateSet = state.validCandidateSet or valid
                state.expectedChoiceSent = state.expectedChoiceSent or (valid and choice == FIXTURE_SKILL)
            body = {"answers": {"route": {"type": "choice", "choice": choice,
                    "probabilities": probabilities, "confidence": 0.99 if valid else 1.0}}}
            encoded = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception:
            body = b'{"error":"invalid synthetic fixture request"}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


class RouterFixture:
    def __init__(self):
        self.state = RouterFixtureState()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), RouterFixtureHandler)
        self.httpd.daemon_threads = True
        self.httpd.fixture_state = self.state
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address
        if host != "127.0.0.1":
            self.stop()
            raise ProbeFailure("router_fixture_not_loopback")
        self.endpoint = f"http://127.0.0.1:{port}"

    def snapshot(self):
        with self.state.lock:
            return {"kind": "synthetic_local_http_router", "requests": self.state.requests,
                    "validCandidateSet": self.state.validCandidateSet,
                    "expectedChoiceSent": self.state.expectedChoiceSent,
                    "productionEfficacyOrCalibrationClaim": False}

    def stop(self):
        if self.thread.is_alive():
            self.httpd.shutdown()
            self.thread.join(timeout=3)
        self.httpd.server_close()
        return not self.thread.is_alive()


class OpenCodeServer:
    def __init__(self, work, env, report_path):
        self.work = work
        self.env = env
        self.proc = None
        self.stdout = None
        self.stderr = None
        self.base = None
        self.stdout_path = report_path.with_suffix(".server.stdout.log")
        self.stderr_path = report_path.with_suffix(".server.stderr.log")

    @staticmethod
    def free_loopback_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def start(self, deadline):
        port = self.free_loopback_port()
        self.stdout = self.stdout_path.open("w", encoding="utf-8")
        self.stderr = self.stderr_path.open("w", encoding="utf-8")
        self.proc = subprocess.Popen(["opencode", "serve", "--hostname=127.0.0.1", f"--port={port}"],
                                     cwd=str(self.work), env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=self.stdout, stderr=self.stderr, start_new_session=True)
        self.base = f"http://127.0.0.1:{port}"
        health_url = self.base + "/global/health"
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise ProbeFailure("isolated_host_server_exited", "unsupported")
            try:
                with urlopen(Request(health_url), timeout=min(1.0, max(0.1, deadline - time.monotonic()))) as response:
                    if response.status == 200:
                        response.read(4096)
                        return
            except (HTTPError, URLError, TimeoutError, OSError):
                pass
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        raise ProbeFailure("isolated_host_server_start_timeout", "unsupported")

    def stop(self):
        cleaned = stop_process(self.proc)
        if self.stdout:
            self.stdout.close()
        if self.stderr:
            self.stderr.close()
        return cleaned


def api_json(server, method, path, work, body, deadline, include_directory=True):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProbeFailure("host_api_timeout", "unsupported")
    query = {"directory": str(work.resolve())} if include_directory else {}
    url = server.base + path + (("?" + urlencode(query)) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urlopen(request, timeout=remaining) as response:
            if response.status not in (200, 201):
                raise ProbeFailure("host_api_status_unsupported", "unsupported")
            chunks = []
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProbeFailure("host_api_timeout", "unsupported")
                sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                if sock is not None:
                    sock.settimeout(remaining)
                chunk = response.read(min(65536, MAX_API_BODY + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_API_BODY:
                    raise ProbeFailure("host_api_response_oversized", "unsupported")
            raw = b"".join(chunks)
    except ProbeFailure:
        raise
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise ProbeFailure("host_api_request_failed", "unsupported") from error
    if len(raw) > MAX_API_BODY:
        raise ProbeFailure("host_api_response_oversized", "unsupported")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProbeFailure("host_api_response_invalid", "unsupported") from error


def permission_evidence(agent):
    rules = agent.get("permission") if isinstance(agent, dict) else None
    if not isinstance(rules, list):
        raise ProbeFailure("agent_permission_rules_unsupported", "unsupported")
    skill_rules = [rule for rule in rules if isinstance(rule, dict) and rule.get("permission") == "skill"]
    wildcard_denied = any(rule.get("pattern") == "*" and rule.get("action") == "deny" for rule in skill_rules)
    fixture_allowed = any(rule.get("pattern") == FIXTURE_SKILL and rule.get("action") == "allow" for rule in skill_rules)
    return {"wildcardDenied": wildcard_denied, "fixtureExplicitlyAllowed": fixture_allowed,
            "skillPermissionRuleCount": len(skill_rules)}


def child_session_probe(work, env, report_path, scenario, args):
    deadline = time.monotonic() + args.timeout
    server = OpenCodeServer(work, env, report_path)
    evidence = {"apiSupported": False, "parentHasNoMessages": False, "childParentMatched": False,
                "promptAgentIsWorker": False, "workerPermission": None}
    try:
        server.start(deadline)
        agents = api_json(server, "GET", "/agent", work, None, deadline)
        if not isinstance(agents, list):
            raise ProbeFailure("agent_list_unsupported", "unsupported")
        worker = next((agent for agent in agents if isinstance(agent, dict) and agent.get("name") == "worker"), None)
        if worker is None:
            raise ProbeFailure("worker_agent_unavailable", "unsupported")
        permission = permission_evidence(worker)
        evidence["workerPermission"] = permission
        reviewer = next((agent for agent in agents if isinstance(agent, dict) and agent.get("name") == "reviewer"), None)
        if reviewer is None:
            raise ProbeFailure("reviewer_agent_unavailable", "unsupported")
        reviewer_permission = permission_evidence(reviewer)
        evidence["reviewerPermission"] = reviewer_permission
        require(reviewer_permission["wildcardDenied"] and not reviewer_permission["fixtureExplicitlyAllowed"],
                "default_reviewer_skill_restriction_not_preserved")
        if scenario == "worker-denied":
            require(permission["wildcardDenied"] and not permission["fixtureExplicitlyAllowed"],
                    "default_worker_skill_restriction_not_preserved")
        else:
            require(permission["wildcardDenied"] and permission["fixtureExplicitlyAllowed"],
                    "test_only_worker_permission_override_not_effective", "unsupported")
        parent = api_json(server, "POST", "/session", work,
                          {"title": "isolated skill probe parent", "agent": "main"}, deadline)
        parent_id = parent.get("id") if isinstance(parent, dict) else None
        if not valid_id(parent_id):
            raise ProbeFailure("parent_session_id_unsupported", "unsupported")
        parent_messages = api_json(server, "GET", f"/session/{quote(parent_id, safe='')}/message",
                                   work, None, deadline)
        evidence["parentHasNoMessages"] = isinstance(parent_messages, list) and len(parent_messages) == 0
        require(evidence["parentHasNoMessages"], "parent_session_was_not_idle")
        child = api_json(server, "POST", "/session", work,
                         {"parentID": parent_id, "title": "isolated skill probe worker child", "agent": "worker"}, deadline)
        child_id = child.get("id") if isinstance(child, dict) else None
        if not valid_id(child_id):
            raise ProbeFailure("child_session_id_unsupported", "unsupported")
        child_parent_id = child.get("parentID")
        if child_parent_id is None:
            child_detail = api_json(server, "GET", f"/session/{quote(child_id, safe='')}", work, None, deadline)
            child_parent_id = child_detail.get("parentID") if isinstance(child_detail, dict) else None
        evidence["childParentMatched"] = child_parent_id == parent_id
        require(evidence["childParentMatched"], "child_parent_relationship_unavailable", "unsupported")
        prompt = ("Call the skill tool with name observation-fixture exactly once, then follow its instruction. "
                  "Do not read files or use other tools.")
        response = api_json(server, "POST", f"/session/{quote(child_id, safe='')}/message", work,
                            {"agent": "worker", "parts": [{"type": "text", "text": prompt}]}, deadline)
        info = response.get("info") if isinstance(response, dict) else None
        evidence["promptAgentIsWorker"] = isinstance(info, dict) and info.get("agent") == "worker"
        evidence["apiSupported"] = True
        evidence["parentSessionID"] = parent_id
        evidence["childSessionID"] = child_id
        evidence["childParentID"] = child_parent_id if valid_id(child_parent_id) else None
        evidence["promptAgent"] = info.get("agent") if isinstance(info, dict) and info.get("agent") in ("main", "worker", "reviewer") else None
        if not evidence["promptAgentIsWorker"]:
            raise ProbeFailure("actual_child_agent_unavailable", "unsupported")
        return evidence
    finally:
        evidence["serverCleanupComplete"] = server.stop()
        if not evidence["serverCleanupComplete"]:
            raise ProbeFailure("isolated_host_server_cleanup_incomplete")


def classify_calls(calls):
    return {"skillToolPartCount": len(calls),
            "completedCount": sum(1 for call in calls if call["status"] == "completed"),
            "errorCount": sum(1 for call in calls if call["status"] == "error"),
            "outcome": ("completed" if any(call["status"] == "completed" for call in calls)
                        else "error" if any(call["status"] == "error" for call in calls)
                        else "absent" if not calls else "unknown")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--observation", choices=("on", "off"), default="off")
    parser.add_argument("--scenario", choices=SCENARIOS, default="main")
    args = parser.parse_args()
    if args.timeout < 1 or args.timeout > 3600:
        parser.error("--timeout must be between 1 and 3600 seconds")
    observe = args.observation == "on"
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    campaign_id = "isolated-skill-probe"
    control = Path(__file__).resolve().with_name("otter-skill-observation.ts")
    work = Path(args.work).resolve()
    isolated_base = Path(os.environ["XDG_STATE_HOME"]).resolve().parent
    require(work.is_relative_to(isolated_base / "work"), "probe_root_not_isolated")
    require((work / ".opencode/skills/observation-fixture/SKILL.md").is_file(), "synthetic_fixture_missing")
    observation_state = Path(os.environ["XDG_STATE_HOME"]) / "otter" / hashlib.sha1(str(work).encode()).hexdigest()[:12]
    observation_db = observation_state / "skill-observations.sqlite"
    require(not observation_db.exists(), "probe_requires_fresh_isolated_root")
    env = scratch_env(work)
    require("XDG_CONFIG_HOME" in env and "XDG_DATA_HOME" in env and "XDG_STATE_HOME" in env,
            "isolated_xdg_environment_missing")
    os.environ.clear()
    os.environ.update(env)
    report = {
        "kind": "isolated-skill-host-capability-probe", "synthetic": True, "scenario": args.scenario,
        "isolation": {"homeIsolated": True, "callerCredentialEnvironmentForwarded": False,
                      "opencodeServerAuthEnvironmentForwarded": False, "pwdSetToWork": True},
        "calls": [],
        "hostVersion": None,
        "actualHost": {"outcome": "unknown", "classification": "not_observed", "skillToolPartCount": 0,
                        "completedCount": 0, "errorCount": 0, "timedOut": False},
        "supportMatrix": {name: "not_tested" for name in
                          ("main_skill_load", "missing_skill_error", "advice_insertion", "worker_default_denied",
                           "worker_explicit_allowed", "persisted_actual_agent_basis", "recorder_off_no_database",
                           "worker_skill_with_verify_failure")},
        "recorder": {"enabled": observe, "databaseCreated": False},
        "notes": ["Synthetic fixture evidence is not operational usage.",
                  "Returned text does not prove procedural adherence or causal benefit.",
                  "Current file hash cannot authenticate originally loaded bytes.",
                  "Rendered payload SHA may include a scratch path; compare stable returned-body fingerprints or fixture semantics across on/off runs, never assert whole-payload byte identity."],
    }
    failure = None
    router_fixture = None
    activation_attempted = False
    observer_enabled = False
    observer_facts = []
    observer_campaign = None
    session_ids = set()
    calls = []
    run_meta = {"returnCode": None, "timedOut": False}
    child_evidence = None
    try:
        if args.scenario == "verify-failure" and not observe:
            raise ProbeFailure("verify_failure_requires_observation_on", "unsupported")
        try:
            version = subprocess.run(["opencode", "--version"], cwd=str(work), env=env,
                                     stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                     timeout=10, check=False)
            if version.returncode == 0 and version.stdout.strip() and len(version.stdout.strip()) <= 64:
                report["hostVersion"] = version.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            raise ProbeFailure("opencode_version_unavailable", "unsupported")
        if report["hostVersion"] is None:
            raise ProbeFailure("opencode_version_unavailable", "unsupported")

        if observe:
            activation_attempted = True
            activated = run_control(["bun", str(control), "activate", "--root", str(work),
                                     "--campaign-id", campaign_id], work, env)
            if activated.returncode != 0:
                raise ProbeFailure("observer_activation_failed")
            activation = json.loads(activated.stdout)
            binding = activation.get("ownerBinding") if isinstance(activation, dict) else None
            if not isinstance(binding, str) or len(binding) != 64:
                raise ProbeFailure("observer_owner_binding_unavailable", "unsupported")
            observer_enabled = True
            observer = {"campaignID": campaign_id, "ownerBinding": binding}
        else:
            observer = None

        if args.scenario == "advice-only":
            router_fixture = RouterFixture()
        configure_scenario(work, args.scenario, observer, router_fixture.endpoint if router_fixture else None)
        verify_config_sha256 = None
        verify_skill_sha256 = None
        if args.scenario == "verify-failure":
            verify_config_sha256 = hashlib.sha256((work / ".otter" / "otter.jsonc").read_bytes()).hexdigest()
            verify_skill_sha256 = hashlib.sha256(
                (work / ".opencode" / "skills" / FIXTURE_SKILL / "SKILL.md").read_bytes()).hexdigest()

        if args.scenario in ("worker-denied", "worker-allowed"):
            child_evidence = child_session_probe(work, env, report_path, args.scenario, args)
            require(child_evidence["serverCleanupComplete"], "isolated_host_server_cleanup_incomplete")
            session_ids = {child_evidence["childSessionID"]}
            report["sessionIDsObserved"] = len(session_ids)
            host_db = Path(args.db)
            calls = host_skill_parts(host_db, session_ids, FIXTURE_SKILL)
            report["calls"] = calls
            if observer_enabled:
                observer_facts, observer_campaign = observation_data(observation_db, session_ids)
            call_summary = classify_calls(calls)
            report["actualHost"].update(call_summary)
            report["actualHost"]["timedOut"] = False
            report["childSession"] = child_evidence
            report["supportMatrix"]["persisted_actual_agent_basis"] = (
                "pending" if observer_enabled else "not_available_observation_off")
            turns = router_facts(observer_facts, session_ids) if observer_enabled else None
            report["turnEvidence"] = turns if turns is not None else {"available": False}
            if observer_enabled:
                require(turns["workerTurnCount"] >= 1, "persisted_worker_agent_basis_unavailable", "unsupported")
                report["supportMatrix"]["persisted_actual_agent_basis"] = "supported"
            if args.scenario == "worker-denied":
                report["actualHost"]["classification"] = "policy_denied_or_unoffered"
                report["actualHost"]["invocationAbsenceIsNotError"] = call_summary["outcome"] == "absent"
                require(call_summary["outcome"] in ("absent", "error"),
                        "worker_denial_scenario_had_unresolved_invocation", "unsupported")
                require(call_summary["completedCount"] == 0, "default_worker_skill_restriction_not_preserved")
                report["supportMatrix"]["worker_default_denied"] = "supported"
                if call_summary["outcome"] == "absent":
                    report["actualHost"]["classification"] = "policy_denied_or_unoffered_no_invocation"
                elif call_summary["outcome"] == "error":
                    report["actualHost"]["classification"] = "policy_denial_error_not_skill_load"
            else:
                report["actualHost"]["classification"] = "actual_completed_child_skill_load"
                if not calls:
                    report["actualHost"]["classification"] = "no_tool_part_model_did_not_invoke"
                    raise ProbeFailure("model_did_not_invoke_child_skill", "unsupported")
                require(len(calls) == 1 and calls[0]["requestedName"] == FIXTURE_SKILL,
                        "unexpected_child_skill_call")
                require(calls[0]["status"] == "completed" and calls[0]["containsFixtureInstruction"],
                        "child_skill_call_not_completed")
                require(calls[0]["actualAgent"] == "worker", "child_skill_call_agent_mismatch", "unsupported")
                report["supportMatrix"]["worker_explicit_allowed"] = "supported"
            if observer_enabled:
                recorded = call_facts(observer_facts, session_ids)
                if args.scenario == "worker-allowed":
                    validate_recorded_load(observer_facts, session_ids, "completed")
                elif calls and call_summary["outcome"] == "error":
                    if recorded:
                        validate_recorded_load(observer_facts, session_ids, "error")
                        report["actualHost"]["recordedErrorFact"] = True
                    else:
                        report["actualHost"]["errorToolPartWithoutRecorderFact"] = True
                elif not calls:
                    require(not recorded, "observer_recorded_absent_worker_call")
                report["recorder"]["calls"] = len(recorded)
                report["recorder"]["campaign"] = observer_campaign
                report["recorder"]["databaseCreated"] = True
            else:
                require(not observation_db.exists(), "off_observer_database_created")
                report["recorder"]["databaseCreated"] = False
                report["supportMatrix"]["recorder_off_no_database"] = "supported"
            if args.scenario == "worker-denied":
                if observer_enabled:
                    require(observer_campaign["sessionCount"] == 1 and
                            observer_campaign["callCount"] == len(call_facts(observer_facts, session_ids)),
                            "idle_parent_consumed_skill_session_quota")
            elif observer_enabled:
                require(observer_campaign["sessionCount"] == 1 and observer_campaign["callCount"] == 1,
                        "idle_parent_consumed_skill_session_quota")
            report["hostSessionEvidence"] = {
                "childSessionID": child_evidence["childSessionID"],
                "parentSessionID": child_evidence["parentSessionID"],
                "childParentMatched": child_evidence["childParentMatched"],
                "parentHadNoMessages": child_evidence["parentHasNoMessages"],
                "callFactSessionMatchesChild": all(call["sessionID"] == child_evidence["childSessionID"] for call in calls),
                "persistedWorkerTurnMatchesChild": bool(turns and turns["workerTurnCount"] >= 1),
            }
            report["notes"].append("A denied or unoffered skill with no ToolPart is absence of invocation, not a failed load.")
        else:
            if args.scenario == "main":
                prompt = (f"Call the skill tool with name {FIXTURE_SKILL} exactly once, then follow its instruction. "
                          "Do not read files or use other tools.")
            elif args.scenario == "missing-skill":
                prompt = (f"Call the skill tool with name {MISSING_SKILL} exactly once. "
                          "It is intentionally absent; do not substitute another skill or use other tools.")
            elif args.scenario == "verify-failure":
                prompt = (
                    "ulw: This is the OTTER_VERIFY_FAILURE_ACCEPTANCE probe. Delegate exactly one code task and do not "
                    "implement it yourself. Use title 'Write the fixture result marker', detail 'Call the skill tool "
                    "with name observation-fixture exactly once and follow its instruction. Then create only "
                    "worker-result.txt containing OBSERVATION_FIXTURE_LOADED. One attempt only; do not repair the "
                    "intentional verification failure. Finish after this single attempt.', and "
                    "verify command exactly 'bash ./verify.sh'. Do not create any other tasks, call delegate more "
                    "than once, or retry after the queue reports the expected failure."
                )
            else:
                prompt = ("Please briefly describe this synthetic fixture, but do not load or call any skill. "
                          "Do not invoke tools; answer from this instruction only.")
            if args.scenario == "advice-only":
                report["notes"].append("Advice routing used a deterministic synthetic local HTTP stub, not Jev production traffic; no efficacy or calibration claim.")
            stdout_path = report_path.with_suffix(".stdout.jsonl")
            stderr_path = report_path.with_suffix(".stderr.log")
            run_meta = run_logged(["opencode", "run", "--format", "json", "--agent", "main", "--auto", prompt],
                                  work, env, args.timeout, stdout_path, stderr_path)
            session_ids = parse_jsonl_sessions(stdout_path)
            report["sessionIDsObserved"] = len(session_ids)
            report["actualHost"]["timedOut"] = run_meta["timedOut"]
            report["actualHost"]["returnCode"] = run_meta["returnCode"]
            if run_meta["timedOut"]:
                raise ProbeFailure("host_run_timeout", "unsupported")
            if run_meta["returnCode"] != 0 or not session_ids:
                raise ProbeFailure("host_run_or_session_evidence_unavailable", "unsupported")
            if args.scenario == "verify-failure":
                marker = "OTTER_VERIFY_FAILURE_ACCEPTANCE"
                evidence = verify_failure_acceptance(work, args.db, observation_db, session_ids, marker,
                                                     verify_config_sha256, verify_skill_sha256)
                calls = evidence.pop("calls")
                report["calls"] = calls
                report["actualHost"].update(classify_calls(calls))
                report["actualHost"]["classification"] = "completed_child_skill_with_code_owned_verify_failure"
                report["verifyFailure"] = evidence
                report["supportMatrix"]["worker_skill_with_verify_failure"] = "supported"
                report["supportMatrix"]["persisted_actual_agent_basis"] = "supported"
                report["recorder"]["databaseCreated"] = True
                report["recorder"]["calls"] = 1
                report["recorder"]["campaign"] = evidence["recorderCampaign"]
                report["turnEvidence"] = {"workerTurnCount": evidence["observationFacts"]["workerTurnCount"]}
            else:
                expected_name = MISSING_SKILL if args.scenario == "missing-skill" else FIXTURE_SKILL
                calls = host_skill_parts(args.db, session_ids, expected_name)
                report["calls"] = calls
                call_summary = classify_calls(calls)
                report["actualHost"].update(call_summary)
                if args.scenario == "main":
                    report["actualHost"]["classification"] = "actual_completed_skill_load"
                    report["supportMatrix"]["main_skill_load"] = "pending"
                    if not calls:
                        report["actualHost"]["classification"] = "no_tool_part_model_did_not_invoke"
                        raise ProbeFailure("model_did_not_invoke_requested_skill", "unsupported")
                    require(len(calls) == 1 and calls[0]["status"] == "completed", "expected_one_completed_skill_call")
                    require(calls[0]["requestedName"] == FIXTURE_SKILL and calls[0]["containsFixtureInstruction"],
                            "actual_skill_identity_or_content_mismatch")
                    report["supportMatrix"]["main_skill_load"] = "supported"
                elif args.scenario == "missing-skill":
                    report["actualHost"]["classification"] = "missing_skill_invocation_pending"
                    report["supportMatrix"]["missing_skill_error"] = "pending"
                    report["missingSkillEvidence"] = {"fixtureAbsentOnDisk": False,
                                                       "exactTestOnlyPermissionConfigured": True}
                    require(not (work / ".opencode/skills" / MISSING_SKILL / "SKILL.md").exists(),
                            "missing_skill_fixture_was_present")
                    report["missingSkillEvidence"]["fixtureAbsentOnDisk"] = True
                    if not calls:
                        report["actualHost"]["classification"] = "no_tool_part_model_did_not_invoke"
                        raise ProbeFailure("model_did_not_invoke_missing_skill", "unsupported")
                    require(len(calls) == 1 and calls[0]["requestedName"] == MISSING_SKILL,
                            "missing_skill_tool_identity_mismatch")
                    require(calls[0]["status"] == "error", "missing_skill_did_not_return_actual_error")
                    report["actualHost"]["classification"] = "actual_missing_skill_error"
                    report["supportMatrix"]["missing_skill_error"] = "supported"
                else:
                    report["actualHost"]["classification"] = "advice_inserted_without_skill_invocation"
                    report["supportMatrix"]["advice_insertion"] = "pending"
                    require(not calls, "advice_only_prompt_invoked_skill")
                    report["supportMatrix"]["advice_insertion"] = "pending_host_message_check"

                if args.scenario == "advice-only":
                    require(router_fixture is not None, "synthetic_router_fixture_unavailable")
                    router_receipt = router_fixture.snapshot()
                    report["routingFixture"] = router_receipt
                    require(router_receipt["requests"] == 1 and router_receipt["validCandidateSet"]
                            and router_receipt["expectedChoiceSent"], "synthetic_router_choice_not_used")
                    actual_advice_parts = 0
                    with sqlite3.connect(f"file:{Path(args.db).resolve()}?mode=ro", uri=True) as db:
                        for session_id in sorted(session_ids):
                            for message_raw, part_raw in db.execute(
                                    "SELECT m.data, p.data FROM part p JOIN message m ON m.id=p.message_id WHERE p.session_id=?",
                                    (session_id,)):
                                message = json.loads(message_raw)
                                part = json.loads(part_raw)
                                if message.get("role") == "user" and part.get("type") == "text" \
                                        and "<otter-skill-advice>Potentially relevant skill: observation-fixture." in (part.get("text") or ""):
                                    actual_advice_parts += 1
                    report["hostMessageEvidence"] = {"adviceInsertedInActualUserParts": actual_advice_parts > 0,
                                                      "matchingActualUserTextPartCount": actual_advice_parts}
                    require(actual_advice_parts > 0, "advice_missing_from_actual_host_user_parts")
                    report["supportMatrix"]["advice_insertion"] = "supported"

                if observer_enabled:
                    observer_facts, observer_campaign = observation_data(observation_db, session_ids)
                    report["recorder"]["databaseCreated"] = True
                    report["recorder"]["campaign"] = observer_campaign
                    recorded = call_facts(observer_facts, session_ids)
                    report["recorder"]["calls"] = len(recorded)
                    if args.scenario == "main":
                        validate_recorded_load(observer_facts, session_ids, "completed")
                    elif args.scenario == "missing-skill":
                        validate_recorded_load(observer_facts, session_ids, "error")
                    else:
                        turns = router_facts(observer_facts, session_ids)
                        report["turnEvidence"] = turns
                        require(turns["adviceTurnCount"] >= 1, "advice_turn_fact_unavailable", "unsupported")
                        require(observer_campaign["callCount"] == 0, "advice_only_consumed_skill_call_quota")
                else:
                    require(not observation_db.exists(), "off_observer_database_created")
                    report["recorder"]["databaseCreated"] = False
                    report["supportMatrix"]["recorder_off_no_database"] = "supported"

        if args.scenario in ("main", "missing-skill", "worker-denied", "worker-allowed", "verify-failure"):
            report["calls"] = calls
        else:
            report["calls"] = []
        report["sessionIDsObserved"] = len(session_ids)
        report["acceptance"] = {"status": "supported", "reasonCode": "scenario_invariants_verified"}
    except ProbeFailure as error:
        failure = error
    except Exception:
        failure = ProbeFailure("unexpected_probe_failure")
    finally:
        if router_fixture is not None:
            try:
                report["routingFixture"] = router_fixture.snapshot()
                clean = router_fixture.stop()
                report["routerFixtureCleanupComplete"] = clean
                if not clean and failure is None:
                    failure = ProbeFailure("router_fixture_cleanup_incomplete")
            except Exception:
                report["routerFixtureCleanupComplete"] = False
                if failure is None:
                    failure = ProbeFailure("router_fixture_cleanup_incomplete")
        if activation_attempted and observation_db.exists():
            try:
                stopped = run_control(["bun", str(control), "stop", "--root", str(work),
                                       "--campaign-id", campaign_id], work, env)
                closure = json.loads(stopped.stdout) if stopped.returncode == 0 else None
                if not isinstance(closure, dict) or closure.get("status") != "closed":
                    if failure is None:
                        failure = ProbeFailure("observer_close_failed")
                    report["recorder"]["closure"] = {"status": "unavailable"}
                else:
                    report["recorder"]["closure"] = closure
                    if not observer_enabled and failure is None:
                        failure = ProbeFailure("observer_activation_state_unknown")
            except Exception:
                report["recorder"]["closure"] = {"status": "unavailable"}
                if failure is None:
                    failure = ProbeFailure("observer_close_failed")
        if failure is not None:
            report["acceptance"] = {"status": failure.status, "reasonCode": failure.code}
        report["recorder"]["databaseCreated"] = observation_db.exists()
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    if failure is not None:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
