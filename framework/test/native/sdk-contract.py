#!/usr/bin/env python3
"""Probe native OpenCode SDK control-plane behavior without running inference."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MESSAGE_COUNT = 105
START_TIMEOUT_SECONDS = 45.0
HTTP_TIMEOUT_SECONDS = 5.0
COMMAND_NAME = "lca-contract"
PROVIDER_ID = "lca-contract-spy"
MODEL_ID = "lca-contract-model"
AGENT_NAME = "build"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def available_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def unique_run_dir(out_root: Path) -> Path:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    while True:
        run_dir = out_root / f"sdk-contract-{stamp}-{os.getpid()}-{secrets.token_hex(3)}"
        try:
            run_dir.mkdir()
            return run_dir
        except FileExistsError:
            continue


class ApiEvidence:
    def __init__(self, path: Path):
        self.file = path.open("a", encoding="utf-8", buffering=1)
        self.lock = threading.Lock()

    def record(self, entry: dict[str, Any]) -> None:
        with self.lock:
            self.file.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.file.flush()

    def close(self) -> None:
        self.file.close()


def parse_response(raw: bytes) -> Any:
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def request_json(
    evidence: ApiEvidence,
    base_url: str,
    method: str,
    path: str,
    payload: Any = None,
    timeout: float = HTTP_TIMEOUT_SECONDS,
) -> tuple[int | None, Any, str | None]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base_url + path, data=body, headers=headers, method=method)
    started = time.monotonic()
    status: int | None = None
    response: Any = None
    error_text: str | None = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as result:
            status = result.status
            response = parse_response(result.read())
    except urllib.error.HTTPError as error:
        status = error.code
        response = parse_response(error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        error_text = str(error)
    finally:
        evidence.record(
            {
                "at": utc_now(),
                "method": method,
                "url": base_url + path,
                "request": payload,
                "status": status,
                "response": response,
                "transport_error": error_text,
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            }
        )
    return status, response, error_text


class BackendSpy:
    """Reject all provider traffic; never fabricate an inference response."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> int:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def reject(self) -> None:
                length = 0
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    pass
                body = self.rfile.read(min(max(length, 0), 16 * 1024 * 1024)) if length else b""
                entry = {
                    "at": utc_now(),
                    "method": self.command,
                    "path": self.path,
                    "body_bytes": len(body),
                    "body_sha256": hashlib.sha256(body).hexdigest() if body else None,
                }
                with owner.lock:
                    owner.requests.append(entry)
                response = b"LCA contract spy rejects all provider traffic; no fake completion is available.\n"
                self.send_response(503, "Inference disabled by SDK contract probe")
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(response)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(response)
                self.close_connection = True

            do_GET = reject
            do_POST = reject
            do_PUT = reject
            do_PATCH = reject
            do_DELETE = reject
            do_OPTIONS = reject
            do_HEAD = reject

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, name="sdk-contract-spy", daemon=True)
        self.thread.start()
        return int(self.server.server_address[1])

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=5)


def status_observation(status_map: Any, session_id: str) -> dict[str, Any]:
    ensure(isinstance(status_map, dict), "native GET /session/status did not return a JSON object")
    present = session_id in status_map
    value = status_map.get(session_id) if present else None
    kind = "omitted" if not present else "explicit_idle" if isinstance(value, dict) and value.get("type") == "idle" else "explicit_non_idle"
    return {
        "session_id": session_id,
        "entry_present": present,
        "entry": value,
        "observation": kind,
        "raw_map": status_map,
    }


def message_info(entry: Any) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    info = entry.get("info")
    return info if isinstance(info, dict) else None


def isolated_environment(run_dir: Path, config: dict[str, Any], evidence_path: Path, sentinel: str) -> dict[str, str]:
    isolated = run_dir / "isolated"
    home = isolated / "home"
    xdg_config = isolated / "xdg-config"
    xdg_data = isolated / "xdg-data"
    xdg_state = isolated / "xdg-state"
    xdg_cache = isolated / "xdg-cache"
    tmp = isolated / "tmp"
    workspace = isolated / "workspace"
    for directory in (home, xdg_config, xdg_data, xdg_state, xdg_cache, tmp, workspace):
        directory.mkdir(parents=True, exist_ok=True)

    allowed = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL")
    env = {key: os.environ[key] for key in allowed if os.environ.get(key)}
    env.update(
        {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(xdg_config),
            "XDG_DATA_HOME": str(xdg_data),
            "XDG_STATE_HOME": str(xdg_state),
            "XDG_CACHE_HOME": str(xdg_cache),
            "TMPDIR": str(tmp),
            "TMP": str(tmp),
            "TEMP": str(tmp),
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_CONFIG_CONTENT": json.dumps(config, ensure_ascii=False, separators=(",", ":")),
            "LCA_CONTRACT_EVIDENCE": str(evidence_path),
            "LCA_CONTRACT_CHAT_MESSAGE_EVIDENCE": str(run_dir / "first-chat-message.json"),
            "LCA_CONTRACT_SENTINEL": sentinel,
            "LCA_CONTRACT_INPUT": str(run_dir / "plugin-input.json"),
        }
    )
    return env


def wait_for_health(
    process: subprocess.Popen[bytes], evidence: ApiEvidence, base_url: str
) -> dict[str, Any]:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    last_error = "health endpoint did not respond"
    while time.monotonic() < deadline:
        returncode = process.poll()
        if returncode is not None:
            raise RuntimeError(f"OpenCode server exited before health became ready (exit {returncode}); see server logs")
        status, response, transport_error = request_json(
            evidence, base_url, "GET", "/global/health", timeout=1.5
        )
        if status == 200 and isinstance(response, dict) and response.get("healthy") is True:
            ensure(isinstance(response.get("version"), str) and response["version"], "health response omitted runtime version")
            return response
        last_error = transport_error or f"unexpected health response (HTTP {status}): {response!r}"
        time.sleep(0.25)
    raise TimeoutError(f"OpenCode health timeout after {START_TIMEOUT_SECONDS}s: {last_error}")


def cleanup_process(
    process: subprocess.Popen[bytes] | None,
    base_url: str | None,
    evidence: ApiEvidence,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "started": process is not None,
        "pid": process.pid if process is not None else None,
        "terminate_sent": False,
        "kill_sent": False,
        "wait_completed": False,
        "return_code": None,
        "process_alive_after_cleanup": None,
        "server_port_unreachable_after_cleanup": None,
        "errors": [],
    }
    if process is None:
        return result

    if process.poll() is None:
        try:
            process.terminate()
            result["terminate_sent"] = True
        except ProcessLookupError:
            pass
        except OSError as error:
            result["errors"].append(f"terminate: {error}")
        try:
            process.wait(timeout=8)
            result["wait_completed"] = True
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                result["kill_sent"] = True
            except ProcessLookupError:
                pass
            except OSError as error:
                result["errors"].append(f"kill: {error}")
            try:
                process.wait(timeout=8)
                result["wait_completed"] = True
            except (subprocess.TimeoutExpired, OSError) as error:
                result["errors"].append(f"wait after kill: {error}")
    else:
        try:
            process.wait()
            result["wait_completed"] = True
        except OSError as error:
            result["errors"].append(f"wait after exit: {error}")

    result["return_code"] = process.poll()
    result["process_alive_after_cleanup"] = process.poll() is None
    if base_url is not None and not result["process_alive_after_cleanup"]:
        status, _response, transport_error = request_json(
            evidence, base_url, "GET", "/global/health", timeout=1.0
        )
        result["server_port_unreachable_after_cleanup"] = status is None and transport_error is not None
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", required=True, help="absolute path to the installed OpenCode executable")
    parser.add_argument("--out", required=True, help="artifact directory; existing contents are never removed")
    args = parser.parse_args()

    out_root = Path(args.out).expanduser().resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    run_dir = unique_run_dir(out_root)
    paths = {
        "summary": run_dir / "summary.json",
        "api_evidence": run_dir / "api-evidence.jsonl",
        "opencode_config": run_dir / "opencode-config.json",
        "server_stdout": run_dir / "server.stdout.log",
        "server_stderr": run_dir / "server.stderr.log",
        "harness_stdout": run_dir / "harness.stdout.log",
        "harness_stderr": run_dir / "harness.stderr.log",
        "first_chat_message": run_dir / "first-chat-message.json",
        "plugin_hook": run_dir / "plugin-hook.json",
        "plugin_input": run_dir / "plugin-input.json",
    }
    api_evidence = ApiEvidence(paths["api_evidence"])
    server_stdout = paths["server_stdout"].open("wb")
    server_stderr = paths["server_stderr"].open("wb")
    process: subprocess.Popen[bytes] | None = None
    spy = BackendSpy()
    base_url: str | None = None
    cleanup: dict[str, Any] | None = None
    success = False
    summary: dict[str, Any] = {
        "probe": "native OpenCode SDK control-plane only; not full native-engine qualification",
        "started_at": utc_now(),
        "success": False,
        "out_root": str(out_root),
        "run_directory": str(run_dir),
        "artifacts": {key: str(value) for key, value in paths.items()},
        "limitations": [
            "This finite control-plane probe is not full native-engine qualification.",
            "Default message enumeration is observed for this finite history only; it does not establish an unbounded-history guarantee.",
            "The status endpoint observation is preserved as omitted or explicit; the harness does not synthesize an idle map entry.",
        ],
    }

    try:
        opencode_arg = Path(args.opencode).expanduser()
        ensure(opencode_arg.is_absolute(), "--opencode must be an absolute executable path")
        opencode = opencode_arg.resolve(strict=True)
        ensure(opencode.is_file() and os.access(opencode, os.X_OK), f"--opencode is not an executable file: {opencode}")
        plugin_path = Path(__file__).resolve().with_name("sdk-contract-plugin.ts")
        ensure(plugin_path.is_file(), f"required plugin file is missing: {plugin_path}")
        sentinel = f"LCA_SDK_CONTRACT_BEFORE_LLM_{secrets.token_hex(12)}"

        spy_port = spy.start()
        config = {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "share": "disabled",
            "model": f"{PROVIDER_ID}/{MODEL_ID}",
            "provider": {
                PROVIDER_ID: {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "LCA SDK contract loopback spy",
                    "options": {
                        "baseURL": f"http://127.0.0.1:{spy_port}/v1",
                        "apiKey": "lca-contract-no-real-credential",
                    },
                    "models": {
                        MODEL_ID: {
                            "name": "LCA contract control-plane fixture",
                            "limit": {"context": 8192, "output": 1024},
                        }
                    },
                }
            },
            "plugin": [plugin_path.as_uri()],
            "command": {
                COMMAND_NAME: {
                    "description": "SDK contract probe; stops in command.execute.before before inference",
                    "template": "This template must not be sent to a model during the contract probe.",
                    "agent": AGENT_NAME,
                    "model": f"{PROVIDER_ID}/{MODEL_ID}",
                    "subtask": False,
                }
            },
        }
        write_json(paths["opencode_config"], config)
        env = isolated_environment(run_dir, config, paths["plugin_hook"], sentinel)
        isolated_workspace = Path(env["HOME"]).parent / "workspace"
        server_port = available_tcp_port()
        base_url = f"http://127.0.0.1:{server_port}"
        argv = [str(opencode), "serve", "--hostname", "127.0.0.1", "--port", str(server_port)]
        summary.update(
            {
                "opencode_executable": str(opencode),
                "server_command": argv,
                "server_url": base_url,
                "server_port": server_port,
                "workspace": str(isolated_workspace),
                "runtime": {"health": None, "version": None},
                "isolation": {
                    key: env[key]
                    for key in (
                        "HOME",
                        "XDG_CONFIG_HOME",
                        "XDG_DATA_HOME",
                        "XDG_STATE_HOME",
                        "XDG_CACHE_HOME",
                        "TMPDIR",
                    )
                },
                "configuration": {
                    "plugin_uri": plugin_path.as_uri(),
                    "command": COMMAND_NAME,
                    "provider_id": PROVIDER_ID,
                    "model_id": MODEL_ID,
                    "model_backend": f"http://127.0.0.1:{spy_port}/v1",
                    "autoupdate": False,
                    "disable_flags": {
                        "OPENCODE_DISABLE_AUTOUPDATE": env["OPENCODE_DISABLE_AUTOUPDATE"],
                        "OPENCODE_DISABLE_MODELS_FETCH": env["OPENCODE_DISABLE_MODELS_FETCH"],
                    },
                    "credentials": "synthetic loopback-only API key; no real credentials inherited",
                },
            }
        )
        process = subprocess.Popen(
            argv,
            cwd=isolated_workspace,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=server_stdout,
            stderr=server_stderr,
        )
        summary["server_pid"] = process.pid
        health = wait_for_health(process, api_evidence, base_url)
        summary["runtime"] = {"health": health, "version": health["version"]}

        directory_query = urllib.parse.urlencode({"directory": str(isolated_workspace)})
        status, created, error = request_json(
            api_evidence, base_url, "POST", f"/session?{directory_query}", {"title": "SDK contract probe"}
        )
        ensure(status == 200 and isinstance(created, dict), f"native session creation failed (HTTP {status}): {created!r} {error or ''}")
        session_id = created.get("id")
        created_time = created.get("time", {}).get("created") if isinstance(created.get("time"), dict) else None
        ensure(isinstance(session_id, str) and session_id, "native session creation returned no session ID")
        ensure(isinstance(created_time, (int, float)) and not isinstance(created_time, bool), "native session creation returned no numeric creation timestamp")
        sid_path = urllib.parse.quote(session_id, safe="")
        status, fetched, error = request_json(
            api_evidence, base_url, "GET", f"/session/{sid_path}?{directory_query}"
        )
        ensure(status == 200 and isinstance(fetched, dict), f"native session GET failed (HTTP {status}): {fetched!r} {error or ''}")
        fetched_time = fetched.get("time", {}).get("created") if isinstance(fetched.get("time"), dict) else None
        ensure(fetched.get("id") == session_id, "GET /session/{id} returned a different session ID")
        ensure(fetched_time == created_time, "session creation timestamp changed between POST and GET")
        ensure(isinstance(fetched.get("time", {}).get("updated"), (int, float)), "GET /session/{id} omitted its update timestamp")
        ensure(fetched["time"]["updated"] >= created_time, "session update timestamp precedes its creation timestamp")
        summary["session_identity"] = {
            "id": session_id,
            "create_id_matches_get": fetched.get("id") == session_id,
            "created_timestamp": created_time,
            "get_created_timestamp": fetched_time,
            "created_timestamp_matches": fetched_time == created_time,
            "updated_timestamp": fetched["time"]["updated"],
        }

        status, initial_status_map, error = request_json(
            api_evidence, base_url, "GET", f"/session/status?{directory_query}"
        )
        ensure(status == 200, f"native GET /session/status failed (HTTP {status}): {initial_status_map!r} {error or ''}")
        initial_status = status_observation(initial_status_map, session_id)
        ensure(initial_status["observation"] in ("omitted", "explicit_idle"), "newly created session was not idle in native status map")

        message_ids: list[str] = []
        prompt_created_times: list[int | float] = []
        for index in range(MESSAGE_COUNT):
            prompt_body = {
                "agent": AGENT_NAME,
                "model": {"providerID": PROVIDER_ID, "modelID": MODEL_ID},
                "noReply": True,
                "parts": [{"type": "text", "text": f"sdk-contract-user-message-{index:03d}"}],
            }
            status, response, error = request_json(
                api_evidence,
                base_url,
                "POST",
                f"/session/{sid_path}/message?{directory_query}",
                prompt_body,
            )
            ensure(status == 200 and isinstance(response, dict), f"native noReply prompt {index} failed (HTTP {status}): {response!r} {error or ''}")
            info = message_info(response)
            ensure(info is not None and info.get("role") == "user", f"noReply prompt {index} did not return its native user message")
            ensure(info.get("sessionID") == session_id, f"noReply prompt {index} returned another session ID")
            message_id = info.get("id")
            created = info.get("time", {}).get("created") if isinstance(info.get("time"), dict) else None
            ensure(isinstance(message_id, str) and message_id, f"noReply prompt {index} returned no message ID")
            ensure(isinstance(created, (int, float)) and not isinstance(created, bool), f"noReply prompt {index} returned no creation timestamp")
            message_ids.append(message_id)
            prompt_created_times.append(created)

            if index == 0:
                ensure(
                    paths["first_chat_message"].is_file(),
                    "first noReply turn did not leave chat.message SDK-history evidence",
                )
                chat_hook = read_json(paths["first_chat_message"])
                current_message = chat_hook.get("currentMessage")
                ensure(chat_hook.get("phase") == "captured", f"first chat.message hook record is incomplete: {chat_hook!r}")
                ensure(chat_hook.get("hook") == "chat.message", "first-message evidence came from the wrong plugin hook")
                ensure(chat_hook.get("defaultEnumeration") is True and chat_hook.get("limitSupplied") is False, "chat.message SDK enumeration was not the default unbounded-query form")
                ensure(chat_hook.get("sdkErrors") == [], f"first chat.message SDK enumeration failed: {chat_hook.get('sdkErrors')!r}")
                ensure(isinstance(current_message, dict), "chat.message evidence omitted its actual current output.message identity")
                ensure(current_message.get("id") == message_id, "chat.message output.message.id differs from the first native noReply response")
                ensure(current_message.get("role") == "user", "chat.message output.message.role was not user")
                ensure(current_message.get("sessionID") == session_id, "chat.message output.message.sessionID differs from the native session")
                ensure(chat_hook.get("hookInputSessionID") == session_id, "chat.message input session ID differs from the native session")
                ensure(current_message.get("timeCreated") == created, "chat.message output message timestamp differs from the native noReply response")
                chat_ids = chat_hook.get("canonicalMessageIDs")
                chat_count = chat_hook.get("canonicalMessageCount")
                ensure(isinstance(chat_ids, list) and all(isinstance(item, str) for item in chat_ids), "chat.message evidence omitted canonical SDK message IDs")
                ensure(chat_count == len(chat_ids), "chat.message canonical message count does not match its ID list")
                current_in_history = message_id in chat_ids
                ensure(chat_hook.get("currentAlreadyIncluded") is current_in_history, "chat.message current-message inclusion flag disagrees with its canonical ID list")
                history_shape = "empty" if not chat_ids else "only_current" if chat_ids == [message_id] else "other"
                ensure(chat_hook.get("historyShape") == history_shape, "chat.message history shape does not match its canonical IDs")
                ensure(history_shape in ("empty", "only_current"), f"first chat.message history was neither empty nor only the current message: {chat_ids!r}")
                summary["first_chat_message"] = {
                    "evidence": chat_hook,
                    "matches_first_no_reply_response_id": True,
                    "matches_first_no_reply_response_timestamp": True,
                    "history_shape": history_shape,
                    "current_message_already_in_history": current_in_history,
                }

        ensure(len(message_ids) > 100, "probe did not create more than 100 native user messages")
        ensure(len(set(message_ids)) == MESSAGE_COUNT, "native noReply prompts returned duplicate message IDs")
        write_json(
            paths["plugin_input"],
            {
                "command": COMMAND_NAME,
                "sessionID": session_id,
                "expectedMessageCount": MESSAGE_COUNT,
                "messageIDsInCreationOrder": message_ids,
                "firstMessageID": message_ids[0],
            },
        )

        status, native_messages, error = request_json(
            api_evidence, base_url, "GET", f"/session/{sid_path}/message?{directory_query}"
        )
        ensure(status == 200 and isinstance(native_messages, list), f"native default session.messages failed (HTTP {status}): {native_messages!r} {error or ''}")
        canonical_infos = [message_info(item) for item in native_messages]
        canonical_ids = [info.get("id") for info in canonical_infos if info is not None]
        ensure(len(native_messages) == MESSAGE_COUNT, f"default native enumeration returned {len(native_messages)} messages, expected {MESSAGE_COUNT}")
        ensure(len(canonical_ids) == MESSAGE_COUNT, "default native enumeration contained malformed message records")
        ensure(message_ids[0] in canonical_ids, "earliest created user message was not retained in default native enumeration")
        ensure(set(message_ids) == set(canonical_ids), "default native enumeration did not contain exactly the posted user messages")
        earliest_record = next(item for item in native_messages if message_info(item) and message_info(item).get("id") == message_ids[0])

        status, pre_command_status_map, error = request_json(
            api_evidence, base_url, "GET", f"/session/status?{directory_query}"
        )
        ensure(status == 200, f"native GET /session/status before command failed (HTTP {status}): {pre_command_status_map!r} {error or ''}")
        pre_command_status = status_observation(pre_command_status_map, session_id)
        ensure(pre_command_status["observation"] in ("omitted", "explicit_idle"), "session was not idle before native command execution")

        status, commands, error = request_json(api_evidence, base_url, "GET", f"/command?{directory_query}")
        ensure(status == 200 and isinstance(commands, list), f"native command list failed (HTTP {status}): {commands!r} {error or ''}")
        ensure(any(isinstance(item, dict) and item.get("name") == COMMAND_NAME for item in commands), "reserved lca-contract command was not injected into native command listing")

        command_payload = {
            "command": COMMAND_NAME,
            "arguments": "",
            "agent": AGENT_NAME,
            "model": f"{PROVIDER_ID}/{MODEL_ID}",
        }
        command_status, command_response, command_error = request_json(
            api_evidence,
            base_url,
            "POST",
            f"/session/{sid_path}/command?{directory_query}",
            command_payload,
        )
        ensure(command_status is not None and command_status >= 400, "sentinel command unexpectedly succeeded; hook may not have aborted before inference")
        ensure(paths["plugin_hook"].is_file(), "command.execute.before did not leave plugin hook evidence")
        hook = read_json(paths["plugin_hook"])
        ensure(hook.get("phase") == "sentinel-ready", f"plugin hook did not reach its sentinel path: {hook!r}")
        ensure(hook.get("command") == COMMAND_NAME, "plugin hook observed a different command")
        ensure(hook.get("sessionID") == session_id, "plugin hook observed a different session ID")
        ensure(hook.get("sentinel") == sentinel and hook.get("sentinelThrowAttempted") is True, "plugin hook did not record the unique sentinel throw attempt")
        ensure(hook.get("sdkErrors") == [], f"plugin SDK calls failed inside command.execute.before: {hook.get('sdkErrors')!r}")
        hook_messages = hook.get("messages")
        ensure(isinstance(hook_messages, list), "plugin SDK session.messages did not return a canonical array")
        hook_ids = [info.get("id") for item in hook_messages if (info := message_info(item)) is not None]
        ensure(len(hook_messages) == MESSAGE_COUNT, f"plugin SDK default enumeration returned {len(hook_messages)} messages, expected {MESSAGE_COUNT}")
        ensure(message_ids[0] in hook_ids, "plugin SDK default enumeration omitted the earliest created message")
        ensure(set(message_ids) == set(hook_ids), "plugin SDK default enumeration differs from native HTTP default enumeration")
        hook_status = hook.get("statusMap")
        hook_status_observation = status_observation(hook_status, session_id)
        ensure(
            hook_status_observation["observation"] in ("omitted", "explicit_idle"),
            f"session had non-idle native status at command.execute.before: {hook_status_observation!r}",
        )
        ensure(hook_status == pre_command_status_map, "native status map changed between pre-command HTTP observation and SDK hook entry")

        post_status, post_command_status_map, post_error = request_json(
            api_evidence, base_url, "GET", f"/session/status?{directory_query}"
        )
        ensure(post_status == 200, f"native GET /session/status after command failed (HTTP {post_status}): {post_command_status_map!r} {post_error or ''}")
        post_command_status = status_observation(post_command_status_map, session_id)
        ensure(post_command_status["observation"] in ("omitted", "explicit_idle"), "session remained non-idle after sentinel command failed")
        spy_requests = spy.snapshot()
        model_posts = [item for item in spy_requests if item.get("method") == "POST"]
        ensure(not spy_requests, f"loopback provider spy received unexpected traffic: {spy_requests!r}")
        ensure(not model_posts, f"unexpected model POST count: {len(model_posts)}")

        http_text = json.dumps(command_response, ensure_ascii=False)
        sentinel_in_http_error = sentinel in http_text
        summary.update(
            {
                "session_status": {
                    "native_http_before_messages": initial_status,
                    "native_http_before_command": pre_command_status,
                    "sdk_at_command_before": hook_status_observation,
                    "native_http_after_command": post_command_status,
                    "map_unchanged_between_pre_command_and_sdk_hook": hook_status == pre_command_status_map,
                },
                "message_enumeration": {
                    "posted_no_reply_user_messages": MESSAGE_COUNT,
                    "canonical_default_count": len(native_messages),
                    "sdk_hook_default_count": len(hook_messages),
                    "canonical_earliest_created_message_id": message_ids[0],
                    "canonical_earliest_message_retained": message_ids[0] in canonical_ids,
                    "earliest_record": earliest_record,
                    "creation_order_ids": message_ids,
                    "default_response_ids": canonical_ids,
                    "oldest_prompt_timestamp": prompt_created_times[0],
                    "newest_prompt_timestamp": prompt_created_times[-1],
                    "default_limit_query_omitted": True,
                },
                "command_hook": {
                    "command_http_status": command_status,
                    "command_http_response": command_response,
                    "command_transport_error": command_error,
                    "evidence": hook,
                    "sentinel_in_http_error_body": sentinel_in_http_error,
                    "sentinel_observed_by_hook_record_and_http_failure": True,
                },
                "backend_spy": {
                    "url": f"http://127.0.0.1:{spy_port}/v1",
                    "request_count": len(spy_requests),
                    "model_post_count": len(model_posts),
                    "requests": spy_requests,
                    "completion_responses_fabricated": False,
                },
            }
        )
        success = True

    except BaseException as error:
        summary["failure"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }

    finally:
        try:
            cleanup = cleanup_process(process, base_url, api_evidence)
        except BaseException as error:
            cleanup = {
                "started": process is not None,
                "pid": process.pid if process is not None else None,
                "wait_completed": False,
                "process_alive_after_cleanup": process.poll() is None if process is not None else None,
                "errors": [f"cleanup raised {type(error).__name__}: {error}"],
            }
        if process is not None:
            try:
                server_stdout.flush()
                server_stderr.flush()
            except OSError:
                pass
        try:
            spy.stop()
        except BaseException as error:
            summary.setdefault("cleanup_errors", []).append(f"backend spy cleanup: {type(error).__name__}: {error}")
        spy_requests = spy.snapshot()
        model_posts = [item for item in spy_requests if item.get("method") == "POST"]
        if "backend_spy" in summary:
            summary["backend_spy"].update(
                {
                    "request_count": len(spy_requests),
                    "model_post_count": len(model_posts),
                    "requests": spy_requests,
                }
            )
        else:
            summary["backend_spy"] = {
                "request_count": len(spy_requests),
                "model_post_count": len(model_posts),
                "requests": spy_requests,
                "completion_responses_fabricated": False,
            }
        if spy_requests and "failure" not in summary:
            summary["failure"] = {
                "type": "UnexpectedBackendTraffic",
                "message": f"loopback provider spy received {len(spy_requests)} unexpected request(s)",
            }
        summary["cleanup"] = cleanup
        summary["finished_at"] = utc_now()
        summary["success"] = bool(
            success
            and cleanup is not None
            and cleanup.get("wait_completed") is True
            and cleanup.get("process_alive_after_cleanup") is False
            and cleanup.get("server_port_unreachable_after_cleanup") is True
            and not cleanup.get("errors")
            and not spy_requests
            and not summary.get("cleanup_errors")
        )
        api_evidence.close()
        server_stdout.close()
        server_stderr.close()
        output_line = f"SDK contract probe {'PASSED' if summary['success'] else 'FAILED'}; summary: {paths['summary']}\n"
        paths["harness_stdout"].write_text(output_line if summary["success"] else "", encoding="utf-8")
        error_output = ""
        if not summary["success"]:
            error_output = output_line
            if summary.get("failure"):
                error_output += f"{summary['failure']['type']}: {summary['failure']['message']}\n"
        paths["harness_stderr"].write_text(error_output, encoding="utf-8")
        write_json(paths["summary"], summary)
        if summary["success"]:
            sys.stdout.write(output_line)
            sys.stdout.flush()
        else:
            sys.stderr.write(error_output)
            sys.stderr.flush()

    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
