#!/usr/bin/env python3
"""Bounded headless qualification of the real LCA OpenCode skill product path."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
import os
import secrets
import shutil
import signal
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request: Any, _fp: Any, _code: int, _msg: str, _headers: Any, _url: str) -> None:
        return None


DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
EXPECTED_OPENCODE_VERSION = "1.18.35"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
MODEL = "qwen3.6:35b-a3b-coding-mtp-q4_K_M"
PROVIDER_ID = "ollama-lca-product"
SKILL_NAME = "lca-native-contract"
SKILL_TOOL_DESCRIPTION = "Load one registered LCA skill by name. Source, role, and current-session authorization are checked by the runtime."
VENDOR_SKILL_NAME = "lca-unchecked-vendor"
REFERENCE_RELATIVE_PATH = f".agents/skills/{SKILL_NAME}/reference.txt"
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_PROVIDER_REQUESTS = 12
MODEL_TIMEOUT_SECONDS = 900
HTTP_TIMEOUT_SECONDS = 8


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_jsonl(path: Path, value: Any) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    result: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if isinstance(value, dict):
                result.append(value)
    return result


def ensure(condition: Any, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def available_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def unique_run_dir(out_root: Path) -> Path:
    out_root.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    while True:
        run_dir = out_root / f"lca-skill-contract-{stamp}-{os.getpid()}-{secrets.token_hex(3)}"
        try:
            run_dir.mkdir()
            return run_dir
        except FileExistsError:
            continue


def parse_json_or_text(body: bytes) -> Any:
    text = body.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def request_json(
    evidence_path: Path,
    base_url: str,
    method: str,
    path: str,
    payload: Any = None,
    timeout: float = HTTP_TIMEOUT_SECONDS,
) -> tuple[int | None, Any, str | None]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base_url + path, data=body, headers=headers, method=method)
    started = time.monotonic()
    status: int | None = None
    response: Any = None
    error_text: str | None = None
    try:
        with DIRECT_OPENER.open(request, timeout=timeout) as result:
            status = result.status
            response = parse_json_or_text(result.read())
    except urllib.error.HTTPError as error:
        status = error.code
        response = parse_json_or_text(error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        error_text = str(error)
    finally:
        append_jsonl(evidence_path, {
            "at": utc_now(), "method": method, "url": base_url + path, "request": payload,
            "status": status, "response": response, "transport_error": error_text,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        })
    return status, response, error_text


def ensure_loopback_base_url(raw: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(raw)
    ensure(parsed.scheme == "http", "Ollama base URL must use local plain HTTP")
    ensure(parsed.hostname in ("127.0.0.1", "localhost", "::1"), "Ollama base URL must be loopback")
    ensure(parsed.username is None and parsed.password is None, "Ollama base URL must not contain credentials")
    ensure(parsed.path.rstrip("/") == "/v1", "Ollama base URL must end in /v1")
    ensure(parsed.query == "" and parsed.fragment == "", "Ollama base URL may not contain query or fragment")
    ensure(parsed.port is not None, "Ollama base URL must specify a port")
    return parsed


def ollama_inventory(base: urllib.parse.SplitResult, evidence_path: Path) -> dict[str, Any]:
    root = f"{base.scheme}://{base.netloc}"
    url = root + "/api/tags"
    started = time.monotonic()
    status: int | None = None
    data: Any = None
    error_text: str | None = None
    try:
        with DIRECT_OPENER.open(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=HTTP_TIMEOUT_SECONDS) as response:
            status = response.status
            data = parse_json_or_text(response.read())
    except urllib.error.HTTPError as error:
        status = error.code
        data = parse_json_or_text(error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        error_text = str(error)
    models = data.get("models") if isinstance(data, dict) else None
    names = [item.get("name") for item in models if isinstance(item, dict) and isinstance(item.get("name"), str)] if isinstance(models, list) else []
    result = {
        "at": utc_now(), "url": url, "status": status, "model_names": names,
        "expected_model": MODEL, "expected_model_installed": MODEL in names,
        "response": data, "transport_error": error_text,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
    }
    write_json(evidence_path, result)
    ensure(status == 200 and MODEL in names, f"required local Ollama model {MODEL!r} is not installed; inventory: {result!r}")
    return result


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in flatten_strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in flatten_strings(item)]
    return []


def message_texts(data: Any, role: str) -> list[str]:
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return []
    result: list[str] = []
    for message in data["messages"]:
        if not isinstance(message, dict) or message.get("role") != role:
            continue
        content = message.get("content")
        if isinstance(content, str):
            result.append(content)
        elif isinstance(content, list):
            result.append("".join(flatten_strings(content)))
    return result


def system_message_texts(data: Any) -> list[str]:
    return message_texts(data, "system")


def request_tool_names(data: Any) -> list[str]:
    tools = data.get("tools") if isinstance(data, dict) else None
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for item in tools:
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.append(function["name"])
        elif isinstance(item.get("name"), str):
            names.append(item["name"])
    return names


def response_observations(body: bytes) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    payloads: list[dict[str, Any]] = []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            payloads.append(parsed)
    except json.JSONDecodeError:
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                payloads.append(parsed)

    calls: dict[str, dict[str, str]] = {}
    texts: list[str] = []
    finish_reasons: list[str] = []
    model_names: list[str] = []
    for payload in payloads:
        if isinstance(payload.get("model"), str):
            model_names.append(payload["model"])
        choices = payload.get("choices")
        if not isinstance(choices, list):
            continue
        for choice_index, choice in enumerate(choices):
            if not isinstance(choice, dict):
                continue
            if isinstance(choice.get("finish_reason"), str):
                finish_reasons.append(choice["finish_reason"])
            message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
            delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
            content = message.get("content", delta.get("content"))
            if isinstance(content, str):
                texts.append(content)
            tool_calls = message.get("tool_calls", delta.get("tool_calls"))
            if not isinstance(tool_calls, list):
                continue
            for item_index, item in enumerate(tool_calls):
                if not isinstance(item, dict):
                    continue
                call_key = str(item.get("index", item.get("id", f"{choice_index}:{item_index}")))
                call = calls.setdefault(call_key, {"name": "", "arguments": "", "id": ""})
                if isinstance(item.get("id"), str):
                    call["id"] = item["id"]
                function = item.get("function")
                if isinstance(function, dict):
                    if isinstance(function.get("name"), str):
                        call["name"] += function["name"]
                    if isinstance(function.get("arguments"), str):
                        call["arguments"] += function["arguments"]
    return {
        "model_names": list(dict.fromkeys(model_names)), "tool_calls": list(calls.values()),
        "text": "".join(texts), "finish_reasons": finish_reasons, "parsed_payload_count": len(payloads),
    }


def read_effective_main_prompt(evidence_path: Path) -> str | None:
    prompts = [event.get("prompt") for event in read_jsonl(evidence_path)
               if event.get("phase") == "product.config.after" and event.get("role") == "main"]
    if not prompts or not all(isinstance(prompt, str) and prompt for prompt in prompts):
        return None
    if len(set(prompts)) != 1:
        return None
    return prompts[0]


class RecordingProxy:
    """Record provider traffic; forward only real, marker-free main-agent requests to loopback Ollama."""

    def __init__(self, upstream: urllib.parse.SplitResult, evidence_path: Path, product_evidence: Path, markers: dict[str, str],
                 prompts: dict[str, str], common_skill_bytes: bytes, captured_reference_output: str):
        self.upstream = upstream
        self.evidence_path = evidence_path
        self.product_evidence = product_evidence
        self.markers = markers
        self.prompts = prompts
        self.common_skill_text = common_skill_bytes.decode("utf-8", errors="strict")
        self.captured_reference_output = captured_reference_output
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.active_connections: set[http.client.HTTPConnection] = set()
        self.stopping = False
        self.seen_requests = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def _respond(self, status: int, body: bytes, content_type: str = "text/plain; charset=utf-8") -> None:
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if body:
                        self.wfile.write(body)
                except OSError:
                    pass
                self.close_connection = True

            def do_GET(self) -> None:
                if self.path == "/__lca_health":
                    self._respond(200, b'{"healthy":true}\n', "application/json")
                    return
                self._respond(404, b"not found\n")

            def do_POST(self) -> None:
                started = time.monotonic()
                with owner.lock:
                    owner.seen_requests += 1
                    request_number = owner.seen_requests
                    stopping = owner.stopping
                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_BODY_BYTES:
                    request_body = b""
                    body_problem = "provider request has a missing, invalid, or oversized Content-Length"
                else:
                    request_body = self.rfile.read(length)
                    body_problem = None if len(request_body) == length else "provider request body ended before Content-Length"

                parsed: Any = None
                parse_error: str | None = None
                try:
                    parsed = json.loads(request_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parse_error = "provider request body is not valid UTF-8 JSON"
                record: dict[str, Any] = {
                    "at": utc_now(), "request_number": request_number, "path": self.path,
                    "request_body": request_body.decode("utf-8", errors="replace"),
                    "request_body_sha256": sha256_bytes(request_body), "request_body_bytes": len(request_body),
                    "request_json_error": parse_error, "request": parsed,
                    "forwarded": False, "http_status": None, "upstream_response_body": "",
                    "upstream_response_sha256": None, "upstream_observations": None,
                }
                record["model"] = parsed.get("model") if isinstance(parsed, dict) else None
                record["request_tool_names"] = request_tool_names(parsed)
                record["tool_definitions"] = parsed.get("tools") if isinstance(parsed, dict) else None
                record["system_message_texts"] = system_message_texts(parsed)
                record["user_message_texts"] = message_texts(parsed, "user")
                current_user_text = record["user_message_texts"][-1] if record["user_message_texts"] else ""
                matching_scenarios = [name for name, prompt in owner.prompts.items() if prompt in current_user_text]
                record["scenario"] = matching_scenarios[0] if len(matching_scenarios) == 1 else None
                tool_texts = message_texts(parsed, "tool")
                description_marker = owner.markers["unchecked_vendor_description"]
                strings = flatten_strings(parsed)
                found = [name for name, marker in owner.markers.items()
                         if marker.encode("utf-8") in request_body or marker in strings]
                record["unchecked_markers_detected"] = found
                record["unchecked_vendor_description_marker_in_system"] = any(
                    description_marker in text for text in record["system_message_texts"]
                )
                record["exact_common_tool_result_present"] = any(
                    owner.common_skill_text in text for text in tool_texts
                )
                record["exact_captured_reference_result_present"] = any(
                    owner.captured_reference_output in text for text in tool_texts
                )

                block_reason: str | None = None
                if stopping:
                    block_reason = "recording proxy is stopping"
                elif body_problem:
                    block_reason = body_problem
                elif request_number > MAX_PROVIDER_REQUESTS:
                    block_reason = "bounded provider request limit exceeded"
                elif found:
                    block_reason = "request contains an unchecked vendor metadata or changed-payload marker"
                elif self.path.split("?", 1)[0] != "/v1/chat/completions":
                    block_reason = "only native chat-completions requests may be forwarded"
                elif not isinstance(parsed, dict):
                    block_reason = "provider request must be a JSON object"
                elif record["scenario"] is None:
                    block_reason = "provider request did not preserve exactly one submitted qualification prompt"
                elif record["model"] not in (MODEL, f"{PROVIDER_ID}/{MODEL}") and not str(record["model"] or "").endswith(f"/{MODEL}"):
                    block_reason = "provider request selected a model other than the required local Ollama model"
                else:
                    expected_system = read_effective_main_prompt(owner.product_evidence)
                    if expected_system is None:
                        block_reason = "actual LCA main prompt was not observed from the product config hook"
                    elif record["system_message_texts"] != [expected_system]:
                        block_reason = "provider request system channel differs from the actual frozen LCA main policy"
                    elif len(record["request_tool_names"]) != 2 or set(record["request_tool_names"]) != {"skill", "read"}:
                        block_reason = "native provider request did not expose exactly the actual LCA skill and SDK read tools"
                    else:
                        tools = record["tool_definitions"]
                        definitions = {
                            item.get("function", {}).get("name"): item.get("function")
                            for item in tools if isinstance(item, dict) and isinstance(item.get("function"), dict)
                        } if isinstance(tools, list) else {}
                        skill_function = definitions.get("skill")
                        skill_parameters = skill_function.get("parameters") if isinstance(skill_function, dict) else None
                        skill_properties = skill_parameters.get("properties") if isinstance(skill_parameters, dict) else None
                        skill_name_schema = skill_properties.get("name") if isinstance(skill_properties, dict) else None
                        read_function = definitions.get("read")
                        read_parameters = read_function.get("parameters") if isinstance(read_function, dict) else None
                        read_properties = read_parameters.get("properties") if isinstance(read_parameters, dict) else None
                        file_path_schema = read_properties.get("filePath") if isinstance(read_properties, dict) else None
                        if len(definitions) != 2 or not isinstance(skill_function, dict) or skill_function.get("description") != SKILL_TOOL_DESCRIPTION:
                            block_reason = "provider did not expose the exact actual LCA skill tool definition"
                        elif not isinstance(skill_parameters, dict) or not isinstance(skill_name_schema, dict) or skill_name_schema.get("type") != "string" or not isinstance(skill_parameters.get("required"), list) or "name" not in skill_parameters["required"]:
                            block_reason = "actual LCA skill tool did not retain its required string name argument"
                        elif not isinstance(read_parameters, dict) or not isinstance(file_path_schema, dict) or file_path_schema.get("type") != "string" or not isinstance(read_parameters.get("required"), list) or "filePath" not in read_parameters["required"]:
                            block_reason = "native SDK read tool did not retain its required filePath argument"
                    if block_reason is None and not any(prompt in text for text in record["user_message_texts"] for prompt in owner.prompts.values()):
                        block_reason = "original main-turn user message is absent from provider context"

                if block_reason:
                    record["forwarding_block_reason"] = block_reason
                    owner.save_record(record, started)
                    self._respond(422, f"LCA product qualification proxy refused forwarding: {block_reason}.\n".encode("utf-8"))
                    return

                connection = http.client.HTTPConnection(owner.upstream.hostname, owner.upstream.port, timeout=MODEL_TIMEOUT_SECONDS)
                with owner.lock:
                    stopping = owner.stopping
                    if not stopping:
                        owner.active_connections.add(connection)
                if stopping:
                    connection.close()
                    record["proxy_error"] = "recording proxy is stopping"
                    owner.save_record(record, started)
                    self._respond(502, b"local proxy stopped; no completion was generated\n")
                    return
                response_body = b""
                try:
                    connection.request("POST", self.path, body=request_body, headers={
                        "Content-Type": self.headers.get("Content-Type", "application/json"),
                        "Accept": self.headers.get("Accept", "application/json"),
                        "User-Agent": "lca-native-product-contract/1",
                    })
                    record["forwarded"] = True
                    upstream_response = connection.getresponse()
                    response_body = upstream_response.read()
                    record["http_status"] = upstream_response.status
                    record["upstream_reason"] = upstream_response.reason
                    record["upstream_response_body"] = response_body.decode("utf-8", errors="replace")
                    record["upstream_response_sha256"] = sha256_bytes(response_body)
                    observations = response_observations(response_body)
                    record["upstream_observations"] = observations
                    unexpected = [call for call in observations["tool_calls"] if call.get("name") not in ("skill", "read")]
                    if unexpected or len(observations["tool_calls"]) > 1:
                        record["response_block_reason"] = "real Ollama response requested an unauthorized or parallel native tool call"
                        owner.save_record(record, started)
                        self._respond(422, b"LCA product qualification proxy refused a non-skill call; no tool was executed.\n")
                        return
                    response_type = upstream_response.getheader("Content-Type") or "application/json"
                    owner.save_record(record, started)
                    self._respond(upstream_response.status, response_body, response_type)
                except (OSError, http.client.HTTPException, TimeoutError) as error:
                    record["proxy_error"] = f"{type(error).__name__}: {error}"
                    owner.save_record(record, started)
                    self._respond(502, b"loopback Ollama request failed; no synthetic completion was returned\n")
                finally:
                    with owner.lock:
                        owner.active_connections.discard(connection)
                    connection.close()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, name="lca-native-product-proxy", daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])
        self.base_url = f"http://127.0.0.1:{self.port}"

    def save_record(self, record: dict[str, Any], started: float) -> None:
        record["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        with self.lock:
            self.requests.append(record)
            append_jsonl(self.evidence_path, record)

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def stop(self) -> None:
        with self.lock:
            if self.stopping:
                return
            self.stopping = True
            connections = list(self.active_connections)
        for connection in connections:
            connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)
        ensure(not self.thread.is_alive(), "recording proxy request thread did not close")


def run_command(command: list[str], cwd: Path, env: dict[str, str], timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)


def record_command(path: Path, label: str, result: subprocess.CompletedProcess[bytes]) -> None:
    append_jsonl(path, {
        "at": utc_now(), "label": label, "returncode": result.returncode,
        "stdout": result.stdout.decode("utf-8", errors="replace"),
        "stderr": result.stderr.decode("utf-8", errors="replace"),
    })


def git_value(command: list[str], cwd: Path, env: dict[str, str], log_path: Path, label: str) -> str:
    result = run_command(["git", *command], cwd, env, timeout=30)
    record_command(log_path, label, result)
    ensure(result.returncode == 0, f"git {label} failed (exit {result.returncode})")
    return result.stdout.decode("utf-8", errors="strict").rstrip("\r\n")


def prepare_git_worktree(workspace: Path, skill_path: Path, reference_path: Path, lca_config_path: Path, env: dict[str, str], git_evidence: Path) -> dict[str, Any]:
    init = run_command(["git", "init", "--quiet"], workspace, env)
    record_command(git_evidence, "init", init)
    ensure(init.returncode == 0, f"git init failed: {init.stderr.decode('utf-8', errors='replace')}")
    for command, label in [
        (["config", "user.name", "Native LCA product fixture"], "user-name"),
        (["config", "user.email", "native-product@example.invalid"], "user-email"),
        (["config", "core.hooksPath", "/dev/null"], "hooks-path"),
    ]:
        result = run_command(["git", *command], workspace, env)
        record_command(git_evidence, label, result)
        ensure(result.returncode == 0, f"git {label} configuration failed")
    add = run_command(["git", "add", "--", str(skill_path.relative_to(workspace)), str(reference_path.relative_to(workspace)), str(lca_config_path.relative_to(workspace))], workspace, env)
    record_command(git_evidence, "add-fixtures", add)
    ensure(add.returncode == 0, "git could not stage the ordinary project skill and LCA config")
    commit = run_command(["git", "commit", "--quiet", "-m", "native LCA product contract fixture"], workspace, env)
    record_command(git_evidence, "commit", commit)
    ensure(commit.returncode == 0, f"git commit failed: {commit.stderr.decode('utf-8', errors='replace')}")
    root = git_value(["rev-parse", "--show-toplevel"], workspace, env, git_evidence, "show-toplevel")
    is_worktree = git_value(["rev-parse", "--is-inside-work-tree"], workspace, env, git_evidence, "inside-worktree")
    status = git_value(["status", "--porcelain=v1", "--untracked-files=all"], workspace, env, git_evidence, "initial-status")
    tracked_paths = git_value(["ls-files"], workspace, env, git_evidence, "tracked-files").splitlines()
    canonical = str(workspace.resolve(strict=True))
    ensure(root == canonical and is_worktree == "true" and status == "", "fixture is not a clean canonical Git worktree")
    expected_paths = {str(skill_path.relative_to(workspace)), str(reference_path.relative_to(workspace)), str(lca_config_path.relative_to(workspace))}
    ensure(set(tracked_paths) == expected_paths, f"fixture Git index does not contain exactly the tracked qualification inputs: {tracked_paths!r}")
    return {"path": canonical, "git_root": root, "is_worktree": True, "initial_status": status, "initially_clean": True,
            "tracked_paths": tracked_paths}


def wait_for_health(process: subprocess.Popen[bytes], base_url: str, evidence_path: Path) -> dict[str, Any]:
    deadline = time.monotonic() + 45
    last_error = "health endpoint did not respond"
    while time.monotonic() < deadline:
        returncode = process.poll()
        if returncode is not None:
            raise RuntimeError(f"OpenCode server exited before health became ready (exit {returncode})")
        status, body, error = request_json(evidence_path, base_url, "GET", "/global/health", timeout=2)
        if status == 200 and isinstance(body, dict) and body.get("healthy") is True and isinstance(body.get("version"), str):
            return body
        last_error = error or f"HTTP {status}: {body!r}"
        time.sleep(0.25)
    raise TimeoutError(f"OpenCode health timeout after 45 seconds: {last_error}")


def port_unreachable(base_url: str, path: str) -> bool:
    try:
        with DIRECT_OPENER.open(base_url + path, timeout=1) as response:
            response.read()
        return False
    except (urllib.error.URLError, TimeoutError, OSError):
        return True


def cleanup_process(process: subprocess.Popen[bytes] | None, base_url: str | None, evidence_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "started": process is not None, "pid": process.pid if process else None,
        "process_group": process.pid if process else None, "terminate_sent": False,
        "kill_sent": False, "wait_completed": False, "return_code": None,
        "process_alive_after_cleanup": None, "server_port_unreachable_after_cleanup": None, "errors": [],
    }
    if process is None:
        return result
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            result["terminate_sent"] = True
        except ProcessLookupError:
            pass
        except OSError as error:
            result["errors"].append(f"terminate process group: {error}")
    try:
        process.wait(timeout=10)
        result["wait_completed"] = True
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
            result["kill_sent"] = True
        except ProcessLookupError:
            pass
        except OSError as error:
            result["errors"].append(f"kill process group: {error}")
        try:
            process.wait(timeout=10)
            result["wait_completed"] = True
        except subprocess.TimeoutExpired:
            result["errors"].append("OpenCode server did not exit after SIGKILL")
    result["return_code"] = process.poll()
    result["process_alive_after_cleanup"] = process.poll() is None
    if base_url:
        result["server_port_unreachable_after_cleanup"] = port_unreachable(base_url, "/global/health")
    append_jsonl(evidence_path, {"at": utc_now(), "phase": "server.cleanup", **result})
    return result


def prompt_for(scenario: str) -> str:
    if scenario == "changed_baseline":
        return (
            "Native LCA product qualification scenario: changed_baseline.\n"
            "Do not call any tool. Reply with exactly `baseline ready`; this real main turn establishes the session before the tracked skill file is changed. "
            "Do not mention fixture markers."
        )
    if scenario == "common":
        return (
            "Native LCA product qualification scenario: common.\n"
            f"Call the `skill` tool exactly once with name `{SKILL_NAME}`. Only after that skill call succeeds, call the native `read` tool exactly once "
            f"on `{REFERENCE_RELATIVE_PATH}` to read the companion captured resource. Do not call the tools in parallel or use any other tool. "
            "Then reply with exactly two lines: the `Verification phrase:` value from the skill, and the complete single-line text returned by read."
        )
    return (
        f"Native LCA product qualification scenario: {scenario}.\n"
        f"Call the `skill` tool exactly once with name `{SKILL_NAME}` before answering. "
        "If the tool succeeds, copy exactly the one-line value following `Verification phrase:` from its returned instructions. "
        "If the tool refuses, report that it was refused without guessing any phrase. Do not use another tool or mention fixture markers."
    )


def make_fixture_bytes(trusted_marker: str, trusted_phrase: str) -> bytes:
    text = (
        "---\n"
        f"name: {SKILL_NAME}\n"
        "description: Ordinary tracked project skill for native LCA product qualification.\n"
        "allowed-tools: [read]\n"
        "---\n\n"
        "Ordinary tracked project skill for native LCA product qualification.\n"
        f"Trusted captured-body marker: {trusted_marker}\n"
        f"Verification phrase: {trusted_phrase}\n"
        f"After loading this skill, read `{REFERENCE_RELATIVE_PATH}` exactly once using the native read tool.\n"
        "Return the verification phrase and the complete single-line captured reference result.\n"
    )
    return text.encode("utf-8")


def reference_fixture_bytes(marker: str) -> bytes:
    return f"Captured companion resource: {marker}".encode("utf-8")


def changed_fixture_bytes(changed_body_marker: str, changed_phrase: str) -> bytes:
    text = (
        "---\n"
        f"name: {SKILL_NAME}\n"
        "description: Ordinary tracked project skill for native LCA product qualification.\n"
        "allowed-tools: [read]\n"
        "---\n\n"
        "This project skill was changed after its trusted Git baseline.\n"
        f"Unchecked changed payload marker: {changed_body_marker}\n"
        f"Verification phrase: {changed_phrase}\n"
        "This payload must not be dispatched in a headless session.\n"
    )
    return text.encode("utf-8")


def vendor_fixture_bytes(description_marker: str, body_marker: str) -> bytes:
    text = (
        "---\n"
        f"name: {VENDOR_SKILL_NAME}\n"
        f"description: {description_marker}\n"
        "---\n\n"
        f"Unchecked vendor body marker: {body_marker}\n"
        "This home-sourced vendor skill is not authorized by the project policy.\n"
    )
    return text.encode("utf-8")


def make_opencode_config(proxy_base: str, product_plugin: Path, observer_plugin: Path) -> dict[str, Any]:
    disabled_tools = (
        "bash", "glob", "grep", "list", "edit", "write", "patch", "apply_patch", "multiedit",
        "task", "todowrite", "todoread", "question", "lsp", "webfetch", "fetch", "websearch", "search",
        "delegate", "lca_flow", "db_query", "schema_lookup", "shell", "execute",
    )
    native_tools = {name: False for name in disabled_tools}
    # Leave `skill` unlisted: `tools.skill: true` becomes permission skill=allow and overrides LCA's allowlist.
    native_tools["read"] = True
    return {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "model": f"{PROVIDER_ID}/{MODEL}",
        "small_model": f"{PROVIDER_ID}/{MODEL}",
        "enabled_providers": [PROVIDER_ID],
        "provider": {
            PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Local Ollama (recording LCA product qualification proxy)",
                "options": {
                    "baseURL": f"{proxy_base}/v1", "apiKey": "lca-local-product-contract-only",
                    "timeout": MODEL_TIMEOUT_SECONDS * 1000,
                    "headerTimeout": MODEL_TIMEOUT_SECONDS * 1000,
                    "chunkTimeout": MODEL_TIMEOUT_SECONDS * 1000,
                },
                "models": {
                    MODEL: {
                        "name": f"Local Ollama {MODEL}", "tool_call": True,
                        "limit": {"context": 32768, "output": 4096},
                        "modalities": {"input": ["text"], "output": ["text"]},
                    }
                },
            }
        },
        "plugin": [product_plugin.as_uri(), observer_plugin.as_uri()],
        "agent": {
            "main": {
                "mode": "primary",
                "description": "Headless qualification of the actual LCA main skill tool.",
                "model": f"{PROVIDER_ID}/{MODEL}",
                # skill call, captured-resource read, final answer, plus one bounded spare step.
                "maxSteps": 4,
                "tools": native_tools,
            }
        },
        "permission": {"bash": "deny", "edit": "deny", "write": "deny", "webfetch": "deny", "task": "deny"},
    }


def canonical_messages(messages: Any) -> list[dict[str, Any]]:
    ensure(isinstance(messages, list), "native session.messages did not return canonical message history")
    return [message for message in messages if isinstance(message, dict) and isinstance(message.get("info"), dict) and isinstance(message.get("parts"), list)]


def message_text(message: dict[str, Any]) -> str:
    parts = message.get("parts")
    if not isinstance(parts, list):
        return ""
    return "\n".join(part.get("text", "") for part in parts if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str))


def extract_tool_parts(messages: list[dict[str, Any]], tool_name: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        info = message["info"]
        for part in message["parts"]:
            if isinstance(part, dict) and part.get("type") == "tool" and part.get("tool") == tool_name:
                result.append({
                    "tool": part.get("tool"), "callID": part.get("callID"), "sessionID": part.get("sessionID"),
                    "messageID": part.get("messageID"), "assistantMessageID": info.get("id"),
                    "assistantParentID": info.get("parentID"), "assistantRole": info.get("role"),
                    "args": part.get("state", {}).get("input") if isinstance(part.get("state"), dict) else None,
                    "state": part.get("state"), "part": part,
                })
    return result


def assistant_text(messages: list[dict[str, Any]]) -> str:
    return "\n".join(message_text(message) for message in messages if message["info"].get("role") == "assistant")


def run_case(scenario: str, prompt: str, api_url: str, workspace: Path, api_evidence: Path, timeout: int,
             existing_session: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "scenario": scenario, "submitted_prompt": prompt, "session_id": None,
        "submitted_user_message_id": None, "session": None, "prompt_http_status": None,
        "prompt_result": None, "prompt_transport_error": None, "messages_http_status": None,
        "canonical_messages": [], "skill_parts": [], "read_parts": [], "assistant_text": "", "error": None,
    }
    directory_query = urllib.parse.urlencode({"directory": str(workspace)})
    try:
        if existing_session is None:
            status, session, error = request_json(api_evidence, api_url, "POST", f"/session?{directory_query}",
                                                  {"title": f"LCA native product qualification {scenario}"})
            ensure(status == 200 and isinstance(session, dict) and isinstance(session.get("id"), str),
                   f"native {scenario} session creation failed (HTTP {status}): {session!r} {error or ''}")
        else:
            session = existing_session
            ensure(isinstance(session.get("id"), str), f"existing native {scenario} session omitted its ID")
        result["session"] = session
        result["session_id"] = session["id"]
        ensure(session.get("directory") in (None, str(workspace)), "created session directory differs from the isolated worktree")
        if session.get("parentID") not in (None, ""):
            raise RuntimeError("created main session unexpectedly has a parent")
        message_id = f"msg_{secrets.token_hex(12)}"
        result["submitted_user_message_id"] = message_id
        body = {
            "messageID": message_id,
            "agent": "main",
            "model": {"providerID": PROVIDER_ID, "modelID": MODEL},
            "parts": [{"type": "text", "text": prompt}],
        }
        prompt_status, prompt_result, prompt_error = request_json(
            api_evidence, api_url, "POST",
            f"/session/{urllib.parse.quote(session['id'], safe='')}/message?{directory_query}",
            body, timeout=timeout,
        )
        result["prompt_http_status"] = prompt_status
        result["prompt_result"] = prompt_result
        result["prompt_transport_error"] = prompt_error
        messages_status, messages, messages_error = request_json(
            api_evidence, api_url, "GET",
            f"/session/{urllib.parse.quote(session['id'], safe='')}/message?{directory_query}",
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        result["messages_http_status"] = messages_status
        result["messages_error"] = messages_error
        if messages_status == 200:
            canonical = canonical_messages(messages)
            result["canonical_messages"] = canonical
            result["skill_parts"] = extract_tool_parts(canonical, "skill")
            result["read_parts"] = extract_tool_parts(canonical, "read")
            result["assistant_text"] = assistant_text(canonical)
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    return result


def product_transcript_audits(state_home: Path, worktree: Path) -> list[dict[str, Any]]:
    worktree_key = hashlib.sha1(str(worktree.resolve(strict=True)).encode("utf-8")).hexdigest()[:12]
    sessions_root = state_home / worktree_key / "sessions"
    audits: list[dict[str, Any]] = []
    if not sessions_root.is_dir():
        return audits
    prefix = "Skill invocation audit "
    for path in sessions_root.rglob("segments*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            text = record.get("data", {}).get("text") if isinstance(record, dict) and isinstance(record.get("data"), dict) else None
            if record.get("kind") == "notice" and isinstance(text, str) and text.startswith(prefix):
                audit = json.loads(text[len(prefix):])
                if isinstance(audit, dict):
                    audits.append({"record": record, "audit": audit, "source_file": str(path)})
    return audits


def validate_result(
    summary: dict[str, Any],
    scenarios: dict[str, dict[str, Any]],
    common_bytes: bytes,
    changed_bytes: bytes,
    reference_bytes: bytes,
    reference_marker: str,
    markers: dict[str, str],
    proxy_requests: list[dict[str, Any]],
    observer_events: list[dict[str, Any]],
    audits: list[dict[str, Any]],
    git_status_changed: str,
) -> dict[str, Any]:
    ensure(summary["runtime"]["cli_version"].get("exit_code") == 0 and summary["runtime"]["cli_version"].get("stdout") == EXPECTED_OPENCODE_VERSION,
           f"expected OpenCode {EXPECTED_OPENCODE_VERSION}, observed {summary['runtime']['cli_version']!r}")
    ensure(summary["runtime"]["health"].get("version") == EXPECTED_OPENCODE_VERSION, "native server health version does not match the pinned OpenCode release")
    ensure(summary["git_worktree"]["initially_clean"] is True, "common fixture did not start from a clean canonical Git worktree")
    ensure(REFERENCE_RELATIVE_PATH in summary["git_worktree"].get("tracked_paths", []), "captured companion resource was not committed as a tracked Git file")
    ensure(summary["fixture"].get("reference_sha256") == sha256_bytes(reference_bytes) and reference_marker.encode("utf-8") in reference_bytes,
           "captured companion resource bytes or marker differ from the retained fixture")
    ensure(git_status_changed == f" M .agents/skills/{SKILL_NAME}/SKILL.md", f"changed case is not exactly an unstaged tracked skill edit: {git_status_changed!r}")
    baseline_turn = scenarios["changed_baseline"]
    changed_turn = scenarios["changed"]
    ensure(baseline_turn.get("error") is None and baseline_turn.get("prompt_http_status") == 200 and baseline_turn.get("messages_http_status") == 200,
           "custom case did not establish a completed real native main turn before changing the skill")
    ensure(baseline_turn.get("skill_parts") == [] and baseline_turn.get("read_parts") == [] and "baseline ready" in baseline_turn.get("assistant_text", "").lower(),
           "pre-change native baseline turn unexpectedly invoked a skill or did not complete its requested real response")
    ensure(baseline_turn.get("session_id") == changed_turn.get("session_id") and
           baseline_turn.get("submitted_user_message_id") != changed_turn.get("submitted_user_message_id"),
           "changed/custom refusal did not reuse the same actual session after its separate baseline user turn")
    ensure(summary["fixture"].get("changed_baseline_turn_skill_sha256") == sha256_bytes(common_bytes),
           "the changed-case session baseline was not established while the exact common fixture bytes were present")

    config_events = [event for event in observer_events if event.get("phase") == "product.config.after" and event.get("role") == "main"]
    ensure(config_events and all(isinstance(event.get("prompt"), str) and event["prompt"] for event in config_events), "actual LCA config hook did not provide the main system prompt")
    product_prompt = config_events[0]["prompt"]
    ensure(all(event.get("prompt") == product_prompt for event in config_events), "actual main policy prompt changed during the native run")
    skill_permission = config_events[0].get("skillPermission")
    ensure(isinstance(skill_permission, dict) and skill_permission.get("*") == "deny" and skill_permission.get(SKILL_NAME) == "allow" and
           set(skill_permission) == {"*", SKILL_NAME}, "actual product config did not restrict the runtime skill tool to the ordinary tracked fixture")
    ensure(markers["unchecked_vendor_description"] not in product_prompt and markers["unchecked_vendor_body"] not in product_prompt and
           markers["changed_body"] not in product_prompt and markers["changed_phrase"] not in product_prompt and reference_marker not in product_prompt,
           "actual configured LCA main system prompt contains unchecked skill metadata")
    transform_events = [event for event in observer_events if event.get("phase") == "product.system.transform.after"]
    ensure(transform_events, "the real product system-transform path was not observed")
    ensure(all(event.get("system") == [product_prompt] and not event.get("uncheckedDescriptionMarkerPresent") and
               not event.get("uncheckedBodyMarkerPresent") and not event.get("changedBodyMarkerPresent") and
               not event.get("trustedReferenceMarkerPresent") for event in transform_events),
           "product system transform did not preserve the exact frozen main prompt without unchecked markers")

    marker_hits = [request for request in proxy_requests if request.get("unchecked_markers_detected")]
    forwarded = [request for request in proxy_requests if request.get("forwarded") is True]
    blocked_markers = [request for request in marker_hits if request.get("forwarded") is not True]
    ensure(not marker_hits, f"unchecked marker request was blocked before Ollama; qualification fails: {[item.get('unchecked_markers_detected') for item in marker_hits]!r}")
    ensure(not any(request.get("forwarded") is True and request.get("unchecked_markers_detected") for request in proxy_requests), "unchecked marker reached Ollama")
    refused_requests = [request for request in proxy_requests if request.get("forwarding_block_reason") or request.get("response_block_reason") or request.get("proxy_error")]
    ensure(not refused_requests, f"recording proxy refused or failed a provider request: {[item.get('forwarding_block_reason') or item.get('response_block_reason') or item.get('proxy_error') for item in refused_requests]!r}")
    ensure(forwarded and all(request.get("http_status") == 200 for request in forwarded), "no successful real local Ollama inference was observed")
    ensure(all(request.get("request_body_sha256") for request in forwarded), "provider request capture is missing exact request-body hashes")
    ensure(all(request.get("system_message_texts") == [product_prompt] for request in forwarded), "a forwarded provider request differed from the actual frozen LCA main prompt")
    ensure(all(MODEL in (request.get("upstream_observations") or {}).get("model_names", []) for request in forwarded),
           "a real Ollama response did not identify the required local Qwen model")
    ensure(not blocked_markers, "marker request crossed the local proxy boundary")
    ensure(all(len(request.get("request_tool_names", [])) == 2 and set(request.get("request_tool_names", [])) == {"skill", "read"}
               for request in forwarded), "a real model request exposed a tool other than read plus the LCA skill tool")
    baseline_requests = [request for request in forwarded if request.get("scenario") == "changed_baseline"]
    ensure(baseline_requests and all(not (request.get("upstream_observations") or {}).get("tool_calls") for request in baseline_requests),
           "pre-change baseline turn did not complete through the real model without a skill call")

    system_events_by_session: dict[str, int] = {}
    for event in transform_events:
        session_id = event.get("sessionID")
        if isinstance(session_id, str):
            system_events_by_session[session_id] = system_events_by_session.get(session_id, 0) + 1
    observer_init = [event for event in observer_events if event.get("phase") == "observer.initialized"]
    ensure(observer_init and all(event.get("pid") == summary.get("native_server_pid") for event in observer_init), "observer plugin process identity does not match the actual OpenCode server")
    ensure(any(Path(str(event.get("pluginURL", "")).split("?")[0].split("#")[0]).name == "lca-skill-contract-plugin.ts" for event in observer_init), "actual product observer plugin URL was not loaded")
    ensure(summary.get("plugin_uris", {}).get("actual_lca_product") == Path(summary["source_files"]["product_plugin"]).as_uri(),
           "native server configuration did not target the actual framework/src/index.ts product plugin")
    ensure(all(event.get("directory") == summary["git_worktree"]["path"] and event.get("worktree") == summary["git_worktree"]["path"] for event in observer_init),
           "native observer plugin did not share the canonical isolated worktree identity")
    created_events = [event for event in observer_events if event.get("phase") == "native.session.created"]
    expected_session_ids = {scenarios["common"].get("session_id"), scenarios["changed"].get("session_id")}
    created_by_id = {event.get("sessionID"): event for event in created_events}
    ensure(expected_session_ids.issubset(created_by_id), "actual native SDK session.created events were not observed for both product cases")
    ensure(all(created_by_id[session_id].get("directory") == summary["git_worktree"]["path"] and
               created_by_id[session_id].get("parentID") is None for session_id in expected_session_ids),
           "native qualification cases were not canonical root sessions in the isolated worktree")

    before_events = [event for event in observer_events if event.get("phase") in (
        "product.skill.execute.before.observed", "product.read.execute.before.observed",
    )]
    after_events = [event for event in observer_events if event.get("phase") in (
        "product.skill.execute.after.observed", "product.read.execute.after.observed",
    )]
    skill_before_events = [event for event in before_events if event.get("tool") == "skill"]
    skill_after_events = [event for event in after_events if event.get("tool") == "skill"]
    read_before_events = [event for event in before_events if event.get("tool") == "read"]
    read_after_events = [event for event in after_events if event.get("tool") == "read"]
    qualification: dict[str, Any] = {
        "real_product_plugin_loaded_from_framework_src_index": True,
        "headless_created_main_session_turns": True,
        "native_session_created_events": [created_by_id[session_id] for session_id in sorted(expected_session_ids)],
        "actual_product_frozen_system_prompt_observed": True,
        "vendor_description_and_body_excluded_from_frozen_system_and_provider_requests": True,
        "unchecked_marker_requests_blocked_before_ollama": 0,
        "real_ollama_requests_forwarded": len(forwarded),
        "native_tool_before_events": len(before_events),
        "native_tool_after_events": len(after_events),
        "native_skill_before_events": len(skill_before_events),
        "native_skill_after_events": len(skill_after_events),
        "native_read_before_events": len(read_before_events),
        "native_read_after_events": len(read_after_events),
        "synthetic_completions": False,
        "synthetic_execution_ids": False,
    }
    case_evidence: dict[str, Any] = {}
    for name, fixture in (("common", common_bytes), ("changed", changed_bytes)):
        case = scenarios[name]
        ensure(case.get("error") is None, f"{name} main turn failed: {case.get('error')!r}")
        ensure(case.get("prompt_http_status") == 200, f"{name} main turn did not complete through the native API: HTTP {case.get('prompt_http_status')}")
        ensure(case.get("messages_http_status") == 200 and isinstance(case.get("canonical_messages"), list), f"{name} canonical native transcript was unavailable")
        session_id = case.get("session_id")
        ensure(isinstance(session_id, str), f"{name} created session ID is unavailable")
        minimum_system_transforms = 2 if name == "changed" else 1
        ensure(system_events_by_session.get(session_id, 0) >= minimum_system_transforms,
               f"{name} session did not pass through the expected actual frozen system transforms")
        tool_parts = case["skill_parts"]
        ensure(tool_parts, f"{name} native main turn did not produce an actual canonical skill call")
        ensure(all(part.get("assistantRole") == "assistant" and part.get("assistantParentID") == case.get("submitted_user_message_id") for part in tool_parts),
               f"{name} native skill call lacks the submitted canonical assistant parent context")
        read_parts = case.get("read_parts", [])
        if name == "common":
            ensure(len(read_parts) == 1, "common skill continuation did not produce exactly one canonical native read call")
        else:
            ensure(not read_parts, "changed/custom refusal unexpectedly produced a native read call")
        ensure(all(part.get("assistantRole") == "assistant" and part.get("assistantParentID") == case.get("submitted_user_message_id") for part in read_parts),
               f"{name} native read call lacks the submitted canonical assistant parent context")
        call_ids = [part.get("callID") for part in tool_parts]
        ensure(all(isinstance(call_id, str) and call_id for call_id in call_ids) and len(set(call_ids)) == len(call_ids),
               f"{name} canonical native skill call IDs are missing or duplicated")
        read_call_ids = [part.get("callID") for part in read_parts]
        ensure(all(isinstance(call_id, str) and call_id for call_id in read_call_ids) and len(set(read_call_ids)) == len(read_call_ids),
               f"{name} canonical native read call IDs are missing or duplicated")
        if name == "common":
            messages = case["canonical_messages"]
            order = {message["info"].get("id"): index for index, message in enumerate(messages)}
            ensure(order.get(tool_parts[0].get("assistantMessageID"), -1) < order.get(read_parts[0].get("assistantMessageID"), -1),
                   "native assistant requested read before the common skill load completed")
        scenario_before = [event for event in skill_before_events if event.get("scenario") == name]
        scenario_after = [event for event in skill_after_events if event.get("scenario") == name]
        scenario_read_before = [event for event in read_before_events if event.get("scenario") == name]
        scenario_read_after = [event for event in read_after_events if event.get("scenario") == name]
        ensure({event.get("callID") for event in scenario_before} == set(call_ids), f"{name} actual product before-hook proof does not match canonical skill calls")
        ensure({event.get("callID") for event in scenario_read_before} == set(read_call_ids), f"{name} actual product before-hook proof does not match canonical read calls")
        requests = [request for request in forwarded if request.get("scenario") == name]
        ensure(requests, f"{name} scenario has no real provider request")
        real_calls = [call for request in requests for call in (request.get("upstream_observations") or {}).get("tool_calls", [])]
        expected_call_names = ["skill", "read"] if name == "common" else ["skill"]
        ensure([call.get("name") for call in real_calls] == expected_call_names,
               f"{name} real Ollama call order/count differed from the required native continuation: {[call.get('name') for call in real_calls]!r}")
        ensure(len(real_calls) == len(tool_parts) + len(read_parts), f"{name} real Ollama tool-call count differs from canonical native tool calls")
        for call in real_calls:
            try:
                args = json.loads(call.get("arguments", ""))
            except json.JSONDecodeError as error:
                raise RuntimeError(f"{name} Ollama skill arguments were not complete JSON: {call!r}") from error
            if call.get("name") == "skill":
                ensure(args == {"name": SKILL_NAME}, f"{name} Ollama selected a different skill or argument schema: {args!r}")
            else:
                ensure(isinstance(args, dict) and set(args).issubset({"filePath", "offset", "limit"}) and
                       isinstance(args.get("filePath"), str) and
                       os.path.abspath(os.path.join(summary["git_worktree"]["path"], args["filePath"])) == os.path.abspath(summary["fixture"]["reference_path"]),
                       f"{name} Ollama native read arguments do not target the captured companion resource: {args!r}")
                ensure(args.get("offset") is None or isinstance(args["offset"], int) and not isinstance(args["offset"], bool) and args["offset"] >= 0,
                       f"{name} Ollama read offset is outside the native SDK contract: {args!r}")
                ensure(args.get("limit") is None or isinstance(args["limit"], int) and not isinstance(args["limit"], bool) and args["limit"] >= 1,
                       f"{name} Ollama read limit is outside the native SDK contract: {args!r}")

        states = [part.get("state") for part in tool_parts]
        ensure(all(isinstance(state, dict) for state in states), f"{name} canonical skill states are malformed")
        case_evidence[name] = {
            "session_id": session_id,
            "submitted_user_message_id": case.get("submitted_user_message_id"),
            "canonical_skill_calls": tool_parts,
            "canonical_read_calls": read_parts,
            "actual_product_before_hook_events": scenario_before,
            "actual_product_after_hook_events": scenario_after,
            "actual_product_read_before_hook_events": scenario_read_before,
            "actual_product_read_after_hook_events": scenario_read_after,
            "provider_request_count": len(requests),
            "real_model_tool_calls": real_calls,
            "assistant_text": case.get("assistant_text", ""),
            "system_transform_event_count": system_events_by_session.get(session_id, 0),
        }

        if name == "common":
            ensure(len(tool_parts) == 1 and states[0].get("status") == "completed", "common tracked skill did not load successfully exactly once")
            ensure(len(scenario_before) == len(scenario_after) == 1, "common skill did not produce a complete actual product before/after hook lifecycle")
            read_part = read_parts[0]
            read_state = read_part.get("state")
            ensure(isinstance(read_state, dict) and read_state.get("status") == "completed", "native SDK read did not complete exactly once")
            ensure(len(scenario_read_before) == len(scenario_read_after) == 1, "captured resource read did not produce a complete actual product before/after lifecycle")
            part = tool_parts[0]
            ensure(part["state"].get("output") == fixture.decode("utf-8"), "native canonical tool result differs byte-for-byte from the tracked captured SKILL.md")
            event = scenario_after[0]
            ensure(event.get("canonicalToolStatus") == "running", "native after-hook observer did not retain the exact in-flight canonical tool state")
            ensure(event.get("callID") == part.get("callID") and event.get("canonicalAssistantMessageID") == part.get("assistantMessageID"),
                   "actual product after-hook result is not bound to the canonical same-call assistant message")
            ensure(event.get("output") == fixture.decode("utf-8") and event.get("outputSha256") == sha256_bytes(fixture),
                   "actual product after-hook output differs from the exact captured common SKILL.md bytes")
            metadata = event.get("metadata")
            ensure(isinstance(metadata, dict) and metadata.get("source") == "project" and metadata.get("name") == SKILL_NAME and isinstance(metadata.get("contentHash"), str),
                   "actual product result metadata omitted its authorized project capture identity")
            ensure(markers["trusted_body"] in event["output"] and markers["trusted_body"] != markers["unchecked_vendor_description"],
                   "trusted captured-body marker is absent or conflated with unchecked vendor metadata")
            ensure(markers["unchecked_vendor_description"] not in event["output"] and markers["unchecked_vendor_body"] not in event["output"] and
                   markers["changed_body"] not in event["output"] and reference_marker not in event["output"],
                   "common captured bytes contain unchecked vendor or changed-skill markers")
            ensure(markers["trusted_phrase"] in case.get("assistant_text", ""), "final real model answer did not use the captured trusted verification phrase")
            ensure(reference_marker in case.get("assistant_text", ""), "final real model answer did not use the native read result")
            ensure(all(marker not in case.get("assistant_text", "") for marker in (markers["unchecked_vendor_body"], markers["unchecked_vendor_description"], markers["changed_body"])),
                   "common final assistant answer exposed unchecked vendor metadata")
            read_event = scenario_read_after[0]
            expected_reference_output = reference_bytes.decode("utf-8", errors="strict")
            expected_reference_args = read_part.get("args")
            ensure(isinstance(expected_reference_args, dict) and
                   os.path.abspath(os.path.join(summary["git_worktree"]["path"], expected_reference_args.get("filePath", ""))) ==
                   os.path.abspath(summary["fixture"]["reference_path"]),
                   "canonical native read call did not target the tracked captured reference path")
            ensure(read_event.get("canonicalToolStatus") == "running" and read_event.get("callID") == read_part.get("callID") and
                   read_event.get("canonicalAssistantMessageID") == read_part.get("assistantMessageID") and
                   read_event.get("canonicalParentUserMessageID") == case.get("submitted_user_message_id"),
                   "LcaPlugin read after-hook proof is not bound to the canonical same-call assistant parent")
            ensure(read_event.get("args") == expected_reference_args and read_event.get("title") == "LCA captured source" and
                   read_event.get("output") == expected_reference_output and read_event.get("outputSha256") == sha256_bytes(reference_bytes),
                   "LcaPlugin did not render the exact tracked captured reference bytes through the native read formatter")
            read_metadata = read_event.get("metadata")
            ensure(isinstance(read_metadata, dict) and read_metadata == metadata and read_metadata.get("source") == "project" and
                   read_metadata.get("name") == SKILL_NAME and read_metadata.get("contentHash") == metadata.get("contentHash") and
                   read_metadata.get("callID") == part.get("callID"),
                   "LcaPlugin captured read output lost provenance to the authorized skill invocation")
            ensure(read_state.get("output") == expected_reference_output,
                   "canonical native read tool result differs from the exact LcaPlugin captured-resource rendering")

            exposed_requests = []
            for index, request in enumerate(proxy_requests):
                parsed = request.get("request")
                if request.get("scenario") != "common" or not isinstance(parsed, dict):
                    continue
                tool_messages = [message for message in parsed.get("messages", [])
                                 if isinstance(message, dict) and message.get("role") == "tool" and
                                 any(fixture.decode("utf-8") in text for text in flatten_strings(message.get("content")))]
                if tool_messages:
                    exposed_requests.append((index, request))
            call_response_positions = [index for index, request in enumerate(proxy_requests)
                                       if request.get("scenario") == "common" and
                                       any(call.get("name") == "skill" for call in (request.get("upstream_observations") or {}).get("tool_calls", []))]
            ensure(exposed_requests and call_response_positions and all(index > min(call_response_positions) for index, _request in exposed_requests),
                   "exact captured common skill bytes were not confined to a provider request after the real model called the authorized product tool")
            ensure(all(request.get("exact_common_tool_result_present") is True for _index, request in exposed_requests),
                   "exact common captured bytes were not identified in the real provider tool result")
            case_evidence[name]["exact_captured_bytes_reached_provider_after_authorization"] = True
            common_requests = [(index, request) for index, request in enumerate(proxy_requests) if request.get("scenario") == "common"]
            skill_response_positions = [index for index, request in common_requests
                                        if any(call.get("name") == "skill" for call in (request.get("upstream_observations") or {}).get("tool_calls", []))]
            read_response_positions = [index for index, request in common_requests
                                       if any(call.get("name") == "read" for call in (request.get("upstream_observations") or {}).get("tool_calls", []))]
            reference_result_positions = [index for index, request in common_requests
                                          if request.get("exact_captured_reference_result_present") is True]
            ensure(len(skill_response_positions) == len(read_response_positions) == len(reference_result_positions) == 1 and
                   skill_response_positions[0] < read_response_positions[0] < reference_result_positions[0],
                   "provider did not receive exact captured resource output only after genuine skill then read calls")
            case_evidence[name]["exact_captured_reference_rendering_reached_provider_after_native_read"] = True
        else:
            ensure(all(isinstance(state, dict) and state.get("status") == "error" for state in states),
                   "changed/custom headless skill payload was not refused for every canonical tool call")
            ensure(not scenario_after, "changed/custom headless refusal unexpectedly returned a successful product tool result")
            ensure(not scenario_read_before and not scenario_read_after, "changed/custom refusal unexpectedly invoked the native read continuation")
            ensure(all("not currently authorized" in str(state.get("error", "")) for state in states),
                   "changed/custom tool error did not report the product authorization refusal")
            ensure(all(marker not in case.get("assistant_text", "") for marker in (markers["unchecked_vendor_description"], markers["unchecked_vendor_body"], markers["changed_body"], markers["changed_phrase"])),
                   "unauthorized changed-skill body or phrase reached the final assistant answer")
            for request in requests:
                raw = request.get("request_body", "")
                ensure(all(marker not in raw for marker in (markers["unchecked_vendor_description"], markers["unchecked_vendor_body"], markers["changed_body"], markers["changed_phrase"], reference_marker)) and fixture.decode("utf-8") not in raw,
                       "unauthorized changed/custom SKILL.md payload reached a provider request")
            case_evidence[name]["headless_custom_refusal_observed"] = True
            case_evidence[name]["unauthorized_payload_reached_provider"] = False

    common_audits = [entry for entry in audits if entry.get("audit", {}).get("sdkSessionID") == scenarios["common"].get("session_id")]
    changed_audits = [entry for entry in audits if entry.get("audit", {}).get("sdkSessionID") == scenarios["changed"].get("session_id")]
    ensure(len(common_audits) == 1, "successful common product load did not retain exactly one real product skill-invocation audit")
    ensure(not changed_audits, "unauthorized custom headless payload emitted a successful product invocation audit")
    common_call = case_evidence["common"]["canonical_skill_calls"][0]
    audit = common_audits[0]["audit"]
    ensure(audit.get("userMessageID") == scenarios["common"].get("submitted_user_message_id") and
           audit.get("assistantMessageID") == common_call.get("assistantMessageID") and audit.get("callID") == common_call.get("callID") and
           audit.get("name") == SKILL_NAME and audit.get("source") == "project",
           "retained product authorization audit is not bound to the same canonical common-skill call")
    after_event = case_evidence["common"]["actual_product_after_hook_events"][0]
    ensure(audit.get("contentHash") == after_event.get("metadata", {}).get("contentHash"), "product authorization audit and actual result capture hashes differ")
    case_evidence["common"]["retained_product_authorization_audit"] = common_audits
    qualification["cases"] = case_evidence
    qualification["retained_success_audit_count"] = len(common_audits)
    qualification["unauthorized_changed_audit_count"] = len(changed_audits)
    qualification["provider_requests"] = proxy_requests
    qualification["observer_events"] = observer_events
    return qualification


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", default=shutil.which("opencode"), help="absolute path to the pinned OpenCode executable")
    parser.add_argument("--ollama-base-url", default=DEFAULT_OLLAMA_BASE_URL, help="loopback Ollama OpenAI-compatible base URL")
    parser.add_argument("--out-root", default=str(Path(__file__).resolve().parents[3] / "artifacts" / "lca-tui-P4-product-skill-contract"),
                        help="directory for retained evidence (failed runs are never deleted)")
    args = parser.parse_args()

    out_root = Path(args.out_root).expanduser().resolve()
    run_dir = unique_run_dir(out_root)
    api_evidence = run_dir / "native-api.jsonl"
    proxy_evidence = run_dir / "ollama-proxy.jsonl"
    observer_evidence = run_dir / "product-observer.jsonl"
    git_evidence = run_dir / "git-fixture.jsonl"
    paths: dict[str, Path] = {
        "run_dir": run_dir, "api_evidence": api_evidence, "proxy_evidence": proxy_evidence,
        "observer_evidence": observer_evidence, "git_evidence": git_evidence,
        "summary": run_dir / "summary.json", "server_stdout": run_dir / "opencode-server.stdout.log",
        "server_stderr": run_dir / "opencode-server.stderr.log", "harness_stdout": run_dir / "harness.stdout.log",
        "harness_stderr": run_dir / "harness.stderr.log", "ollama_inventory": run_dir / "ollama-inventory.json",
        "opencode_config": run_dir / "opencode-config.json",
    }
    product_plugin = Path(__file__).resolve().parents[2] / "src" / "index.ts"
    observer_plugin = Path(__file__).resolve().with_name("lca-skill-contract-plugin.ts")
    framework_root = Path(__file__).resolve().parents[2]
    plugin_package_path = framework_root / "node_modules" / "@opencode-ai" / "plugin" / "package.json"
    summary: dict[str, Any] = {
        "harness": "lca-native-product-skill-contract",
        "started_at": utc_now(),
        "success": False,
        "run_directory": str(run_dir),
        "qualification_scope": "Real framework/src/index.ts LcaPlugin on a headless OpenCode main session, actual local Ollama inference, ordinary tracked common skill success and changed/custom refusal. This is not a full TUI or production rollout qualification.",
        "limitations": [
            "No TUI interaction is exercised; the changed/custom case intentionally has no attached foreground consent UI.",
            "Only the fixed local Ollama model and this isolated fixture are qualified; no other host, model, or project policy is implied.",
            "The observer is observational only and does not register or replace tools, authorize skills, or synthesize executions.",
            "Unsafe marker requests are refused before Ollama; such a blocked request is evidence of a qualification failure, not a pass.",
            "The harness-owned OpenCode server and recording proxy are stopped and their ports checked; the pre-existing Ollama service is external and deliberately left running.",
            "All run artifacts, including failures and process logs, are retained under the run directory.",
        ],
        "source_files": {
            "product_plugin": str(product_plugin), "observer_plugin": str(observer_plugin),
            "runner": str(Path(__file__).resolve()),
        },
        "runtime": {"cli_version": None, "health": None, "server_command": None, "server_port": None},
        "ollama_model": MODEL,
        "ollama_base_url": args.ollama_base_url,
        "ollama_service_started_or_owned_by_harness": False,
        "attempt_limit_per_user_turn": 1,
        "native_main_user_turn_count": 3,
        "provider_request_limit": MAX_PROVIDER_REQUESTS,
        "scenarios": {},
        "cleanup_errors": [],
    }
    process: subprocess.Popen[bytes] | None = None
    api_url: str | None = None
    proxy: RecordingProxy | None = None
    proxy_port_unreachable: bool | None = None
    cleanup: dict[str, Any] | None = None
    success = False
    workspace: Path | None = None
    env: dict[str, str] | None = None
    common_bytes = b""
    changed_bytes = b""
    vendor_bytes = b""
    reference_bytes = b""
    reference_marker = ""
    markers: dict[str, str] = {}
    prompts = {
        "common": prompt_for("common"),
        "changed_baseline": prompt_for("changed_baseline"),
        "changed": prompt_for("changed"),
    }
    scenarios: dict[str, dict[str, Any]] = {}
    git_status_changed = ""

    try:
        ensure(args.opencode is not None, "OpenCode executable not found; pass --opencode with an absolute executable path")
        opencode_arg = Path(args.opencode).expanduser()
        ensure(opencode_arg.is_absolute(), "--opencode must be an absolute executable path")
        opencode = opencode_arg.resolve(strict=True)
        ensure(opencode.is_file() and os.access(opencode, os.X_OK), f"OpenCode executable is not executable: {opencode}")
        upstream = ensure_loopback_base_url(args.ollama_base_url)
        ensure(product_plugin.is_file() and observer_plugin.is_file(), "actual LCA product plugin or observer source is missing")
        ensure(plugin_package_path.is_file(), f"installed public plugin SDK package is missing: {plugin_package_path}")
        plugin_package = json.loads(plugin_package_path.read_text(encoding="utf-8"))
        ensure(plugin_package.get("name") == "@opencode-ai/plugin", "installed plugin SDK package identity is unexpected")

        markers = {
            "trusted_body": f"LCA_TRUSTED_CAPTURED_BODY_{secrets.token_hex(12)}",
            "trusted_phrase": f"LCA_TRUSTED_SKILL_REPLY_{secrets.token_hex(12)}",
            "unchecked_vendor_description": f"LCA_UNCHECKED_VENDOR_DESCRIPTION_{secrets.token_hex(12)}",
            "unchecked_vendor_body": f"LCA_UNCHECKED_VENDOR_BODY_{secrets.token_hex(12)}",
            "changed_body": f"LCA_UNAUTHORIZED_CHANGED_BODY_{secrets.token_hex(12)}",
            "changed_phrase": f"LCA_UNAUTHORIZED_CHANGED_REPLY_{secrets.token_hex(12)}",
        }
        reference_marker = f"LCA_TRUSTED_CAPTURED_REFERENCE_{secrets.token_hex(12)}"
        common_bytes = make_fixture_bytes(markers["trusted_body"], markers["trusted_phrase"])
        changed_bytes = changed_fixture_bytes(markers["changed_body"], markers["changed_phrase"])
        vendor_bytes = vendor_fixture_bytes(markers["unchecked_vendor_description"], markers["unchecked_vendor_body"])
        reference_bytes = reference_fixture_bytes(reference_marker)
        common_text = common_bytes.decode("utf-8")
        changed_text = changed_bytes.decode("utf-8")
        vendor_text = vendor_bytes.decode("utf-8")
        ensure(len(set(markers.values())) == len(markers) and markers["trusted_body"] in common_text and markers["trusted_phrase"] in common_text and
               all(marker not in common_text for marker in (markers["unchecked_vendor_description"], markers["unchecked_vendor_body"], markers["changed_body"], markers["changed_phrase"])) and
               markers["unchecked_vendor_description"] in vendor_text and markers["unchecked_vendor_body"] in vendor_text and
               markers["changed_body"] in changed_text and markers["changed_phrase"] in changed_text and
               markers["trusted_body"] not in vendor_text and reference_marker not in "\n".join((common_text, changed_text, vendor_text)) and
               reference_marker not in "\n".join(markers.values()) and b"\n" not in reference_bytes and b"\r" not in reference_bytes,
               "trusted, vendor, and changed-payload marker fixtures must be distinct")

        inventory = ollama_inventory(upstream, paths["ollama_inventory"])
        summary["ollama_model_inventory"] = inventory
        home = run_dir / "isolated" / "home"
        workspace = run_dir / "isolated" / "workspace"
        skill_path = workspace / ".agents" / "skills" / SKILL_NAME / "SKILL.md"
        reference_path = workspace / REFERENCE_RELATIVE_PATH
        vendor_skill_path = home / ".agents" / "skills" / VENDOR_SKILL_NAME / "SKILL.md"
        lca_config_path = workspace / ".lca" / "lca.jsonc"
        skill_path.parent.mkdir(parents=True, exist_ok=True)
        vendor_skill_path.parent.mkdir(parents=True, exist_ok=True)
        lca_config_path.parent.mkdir(parents=True, exist_ok=True)
        skill_path.write_bytes(common_bytes)
        reference_path.write_bytes(reference_bytes)
        vendor_skill_path.write_bytes(vendor_bytes)
        lca_config_path.write_text(json.dumps({"models": {"main": f"{PROVIDER_ID}/{MODEL}"}, "skills": {"allow": [SKILL_NAME]}}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        initial_env = os.environ.copy()
        isolated_dirs = run_dir / "isolated"
        for name, directory in {
            "HOME": home, "XDG_CONFIG_HOME": isolated_dirs / "xdg-config", "XDG_DATA_HOME": isolated_dirs / "xdg-data",
            "XDG_STATE_HOME": isolated_dirs / "xdg-state", "XDG_CACHE_HOME": isolated_dirs / "xdg-cache",
            "TMPDIR": isolated_dirs / "tmp", "WORKSPACE": workspace, "LCA_STATE_HOME": isolated_dirs / "lca-state",
        }.items():
            directory.mkdir(parents=True, exist_ok=True)
        keep_env = {key: initial_env[key] for key in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL") if initial_env.get(key)}
        env = keep_env
        git_config = isolated_dirs / "gitconfig"
        git_config.write_text("", encoding="utf-8")
        env.update({
            "HOME": str(home), "XDG_CONFIG_HOME": str(isolated_dirs / "xdg-config"),
            "XDG_DATA_HOME": str(isolated_dirs / "xdg-data"), "XDG_STATE_HOME": str(isolated_dirs / "xdg-state"),
            "XDG_CACHE_HOME": str(isolated_dirs / "xdg-cache"), "TMPDIR": str(isolated_dirs / "tmp"),
            "TMP": str(isolated_dirs / "tmp"), "TEMP": str(isolated_dirs / "tmp"),
            "LCA_STATE_HOME": str(isolated_dirs / "lca-state"), "GIT_CONFIG_GLOBAL": str(git_config),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
        })
        git_worktree = prepare_git_worktree(workspace, skill_path, reference_path, lca_config_path, env, git_evidence)
        summary["git_worktree"] = git_worktree
        summary["isolation"] = {key: env[key] for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "LCA_STATE_HOME")}
        summary["fixture"] = {
            "skill_name": SKILL_NAME, "skill_path": str(skill_path), "common_bytes": len(common_bytes),
            "common_sha256": sha256_bytes(common_bytes), "changed_bytes": len(changed_bytes),
            "changed_sha256": sha256_bytes(changed_bytes), "tracked_initially": True,
            "reference_path": str(reference_path), "reference_relative_path": REFERENCE_RELATIVE_PATH,
            "reference_bytes": len(reference_bytes), "reference_sha256": sha256_bytes(reference_bytes),
            "trusted_reference_marker": reference_marker,
            "vendor_skill_name": VENDOR_SKILL_NAME, "vendor_skill_path": str(vendor_skill_path),
            "vendor_skill_bytes": len(vendor_bytes), "vendor_skill_sha256": sha256_bytes(vendor_bytes),
            "vendor_skill_source": "isolated user-home skill root, outside the project Git worktree",
            "unchecked_vendor_description_marker": markers["unchecked_vendor_description"],
            "unchecked_vendor_body_marker": markers["unchecked_vendor_body"],
            "changed_payload_body_marker": markers["changed_body"],
            "trusted_captured_body_marker": markers["trusted_body"], "trusted_verification_phrase": markers["trusted_phrase"],
            "changed_payload_verification_phrase": markers["changed_phrase"],
        }

        version_env = {**env, "OPENCODE_CONFIG_CONTENT": "{}"}
        version_result = run_command([str(opencode), "--version"], workspace, version_env, timeout=20)
        paths["version_stdout"] = run_dir / "opencode-version.stdout.log"
        paths["version_stderr"] = run_dir / "opencode-version.stderr.log"
        paths["version_stdout"].write_bytes(version_result.stdout)
        paths["version_stderr"].write_bytes(version_result.stderr)
        version_text = version_result.stdout.decode("utf-8", errors="replace").strip()
        summary["runtime"]["cli_version"] = {
            "stdout": version_text, "stderr": version_result.stderr.decode("utf-8", errors="replace"),
            "exit_code": version_result.returncode,
        }
        ensure(version_result.returncode == 0 and version_text == EXPECTED_OPENCODE_VERSION,
               f"expected OpenCode {EXPECTED_OPENCODE_VERSION}, observed {version_text!r}")

        proxy = RecordingProxy(upstream, proxy_evidence, observer_evidence,
                               {"unchecked_vendor_description": markers["unchecked_vendor_description"],
                                "unchecked_vendor_body": markers["unchecked_vendor_body"],
                                "changed_body": markers["changed_body"],
                                "unauthorized_changed_phrase": markers["changed_phrase"]}, prompts, common_bytes,
                               reference_bytes.decode("utf-8", errors="strict"))
        summary["ollama_proxy_url"] = proxy.base_url
        config = make_opencode_config(proxy.base_url, product_plugin, observer_plugin)
        write_json(paths["opencode_config"], config)
        summary["plugin_uris"] = {"actual_lca_product": product_plugin.as_uri(), "observer": observer_plugin.as_uri()}
        env.update({
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_CONFIG_CONTENT": json.dumps(config, ensure_ascii=False, separators=(",", ":")),
            "LCA_NATIVE_PRODUCT_EVIDENCE": str(observer_evidence),
            "LCA_NATIVE_PRODUCT_PROMPTS": json.dumps(prompts, ensure_ascii=False, separators=(",", ":")),
            "LCA_NATIVE_PRODUCT_VENDOR_DESCRIPTION_MARKER": markers["unchecked_vendor_description"],
            "LCA_NATIVE_PRODUCT_VENDOR_BODY_MARKER": markers["unchecked_vendor_body"],
            "LCA_NATIVE_PRODUCT_CHANGED_BODY_MARKER": markers["changed_body"],
            "LCA_NATIVE_PRODUCT_REFERENCE_MARKER": reference_marker,
        })
        server_port = available_tcp_port()
        api_url = f"http://127.0.0.1:{server_port}"
        server_command = [str(opencode), "serve", "--hostname", "127.0.0.1", "--port", str(server_port)]
        summary["runtime"].update({"server_command": server_command, "server_port": server_port, "server_url": api_url})
        summary["source_hashes"] = {
            "runner_sha256": sha256_file(Path(__file__).resolve()),
            "opencode_executable_sha256": sha256_file(opencode),
            "actual_product_index_sha256": sha256_file(product_plugin),
            "observer_plugin_sha256": sha256_file(observer_plugin),
            "plugin_sdk_package_json_sha256": sha256_file(plugin_package_path),
            "common_skill_sha256": sha256_bytes(common_bytes),
            "changed_skill_sha256": sha256_bytes(changed_bytes),
            "home_vendor_skill_sha256": sha256_bytes(vendor_bytes),
            "captured_reference_sha256": sha256_bytes(reference_bytes),
        }
        summary["public_plugin_api_dependency"] = {
            "package": plugin_package["name"], "version": plugin_package.get("version"),
            "package_json": str(plugin_package_path),
        }
        with paths["server_stdout"].open("wb") as stdout, paths["server_stderr"].open("wb") as stderr:
            process = subprocess.Popen(server_command, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                                       stdout=stdout, stderr=stderr, start_new_session=True)
            summary["native_server_pid"] = process.pid
            health = wait_for_health(process, api_url, api_evidence)
            summary["runtime"]["health"] = health
            ensure(health.get("version") == EXPECTED_OPENCODE_VERSION, f"native OpenCode health version mismatch: {health!r}")

            agent_status, agents, agent_error = request_json(
                api_evidence, api_url, "GET", "/agent?directory=" + urllib.parse.quote(str(workspace), safe=""), timeout=45,
            )
            ensure(agent_status == 200 and isinstance(agents, list) and agent_error is None,
                   f"native instance agent initialization failed: HTTP {agent_status}: {agent_error or agents}")
            observer_deadline = time.monotonic() + 30
            while time.monotonic() < observer_deadline:
                events = read_jsonl(observer_evidence)
                if any(event.get("phase") == "product.config.after" for event in events):
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.2)
            ensure(any(event.get("phase") == "product.config.after" for event in read_jsonl(observer_evidence)),
                   "actual LCA plugin config hook was not observed before main inference")
            observer_init = [event for event in read_jsonl(observer_evidence) if event.get("phase") == "observer.initialized"]
            ensure(any(event.get("pid") == process.pid for event in observer_init), "native observer plugin did not initialize in the actual server process")

            common_case = run_case("common", prompts["common"], api_url, workspace, api_evidence, MODEL_TIMEOUT_SECONDS + 60)
            scenarios["common"] = common_case
            summary["scenarios"]["common"] = common_case

            summary["fixture"]["changed_baseline_turn_skill_sha256"] = sha256_file(skill_path)
            changed_baseline = run_case("changed_baseline", prompts["changed_baseline"], api_url, workspace, api_evidence, MODEL_TIMEOUT_SECONDS + 60)
            scenarios["changed_baseline"] = changed_baseline
            summary["scenarios"]["changed_baseline"] = changed_baseline

            skill_path.write_bytes(changed_bytes)
            git_status_changed = git_value(["status", "--porcelain=v1", "--untracked-files=all"], workspace, env, git_evidence, "changed-skill-status")
            summary["fixture"]["changed_git_status"] = git_status_changed
            changed_case = run_case("changed", prompts["changed"], api_url, workspace, api_evidence,
                                    MODEL_TIMEOUT_SECONDS + 60, existing_session=changed_baseline.get("session"))
            scenarios["changed"] = changed_case
            summary["scenarios"]["changed"] = changed_case

            audit_values = product_transcript_audits(Path(env["LCA_STATE_HOME"]), workspace)
            proxy_requests = proxy.snapshot()
            observer_events = read_jsonl(observer_evidence)
            summary["native_tool_evidence"] = {
                "observer_events": observer_events,
                "before_count": sum(event.get("phase") == "product.tool.execute.before.observed" for event in observer_events),
                "after_count": sum(event.get("phase") == "product.tool.execute.after.observed" for event in observer_events),
            }
            summary["product_invocation_audits"] = audit_values
            qualification = validate_result(summary, scenarios, common_bytes, changed_bytes, reference_bytes, reference_marker, markers,
                                            proxy_requests, observer_events, audit_values, git_status_changed)
            summary["qualification_evidence"] = qualification
            success = True

    except BaseException as error:
        summary["failure"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}

    finally:
        try:
            cleanup = cleanup_process(process, api_url, api_evidence)
        except BaseException as error:
            cleanup = {
                "started": process is not None, "pid": process.pid if process else None,
                "wait_completed": False, "process_alive_after_cleanup": process.poll() is None if process else None,
                "server_port_unreachable_after_cleanup": None,
                "errors": [f"server cleanup raised {type(error).__name__}: {error}"],
            }
        if proxy is not None:
            try:
                proxy.stop()
                proxy_port_unreachable = port_unreachable(proxy.base_url, "/__lca_health")
            except BaseException as error:
                summary["cleanup_errors"].append(f"recording proxy cleanup: {type(error).__name__}: {error}")
            summary["ollama_proxy"] = {
                "listen_url": proxy.base_url, "upstream_url": args.ollama_base_url,
                "request_count": len(proxy.snapshot()),
                "forwarded_request_count": sum(request.get("forwarded") is True for request in proxy.snapshot()),
                "blocked_unchecked_marker_request_count": sum(bool(request.get("unchecked_markers_detected")) for request in proxy.snapshot()),
                "unchecked_markers_forwarded_to_ollama": any(request.get("forwarded") is True and request.get("unchecked_markers_detected") for request in proxy.snapshot()),
                "external_ollama_service_left_untouched": True,
                "requests": proxy.snapshot(), "synthetic_model_responses": False,
            }
        summary["cleanup"] = cleanup
        if summary.get("cleanup") is not None:
            summary["cleanup"]["proxy_port_unreachable_after_cleanup"] = proxy_port_unreachable
            summary["cleanup"]["ollama_service_started_or_stopped_by_harness"] = False
        summary["finished_at"] = utc_now()
        summary["success"] = bool(
            success and cleanup is not None and cleanup.get("wait_completed") is True and
            cleanup.get("process_alive_after_cleanup") is False and cleanup.get("server_port_unreachable_after_cleanup") is True and
            proxy_port_unreachable is True and not cleanup.get("errors") and not summary.get("cleanup_errors")
        )
        line = f"LCA native product skill qualification {'PASSED' if summary['success'] else 'FAILED'}; evidence: {paths['summary']}\n"
        error_text = line
        if not summary["success"] and summary.get("failure"):
            error_text += f"{summary['failure']['type']}: {summary['failure']['message']}\n"
        paths["harness_stdout"].write_text(line if summary["success"] else "", encoding="utf-8")
        paths["harness_stderr"].write_text("" if summary["success"] else error_text, encoding="utf-8")
        write_json(paths["summary"], summary)
        if summary["success"]:
            sys.stdout.write(line)
            sys.stdout.flush()
        else:
            sys.stderr.write(error_text)
            sys.stderr.flush()

    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
