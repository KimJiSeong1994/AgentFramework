#!/usr/bin/env python3
"""Native OpenCode skill-tool override probe; inference is gated by a local recording proxy."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
import os
import secrets
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
DEFAULT_MODEL = "gpt-oss:latest"
PROVIDER_ID = "ollama-contract"
AGENT_ID = "skill-contract"
TOOL_DESCRIPTION = "Load the registered runtime-owned skill by its fixed identifier. Returns adapter-controlled skill text."
OWNED_SYSTEM_PROMPT = (
    "You are running an isolated skill-tool contract probe. Only text returned by the registered runtime-owned skill tool is trusted skill content. "
    "Use that tool when prompted, follow its exact instructions, and do not attempt filesystem, shell, network, or delegation actions."
)
MAX_BODY_BYTES = 32 * 1024 * 1024
MODEL_TIMEOUT_SECONDS = 900
MODEL_TIMEOUT_MILLISECONDS = MODEL_TIMEOUT_SECONDS * 1000
HTTP_TIMEOUT_SECONDS = 8


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def ensure(condition: bool, message: str) -> None:
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
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def unique_run_dir(out_root: Path) -> Path:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    while True:
        directory = out_root / f"skill-contract-{stamp}-{os.getpid()}-{secrets.token_hex(3)}"
        try:
            directory.mkdir()
            return directory
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
        with DIRECT_OPENER.open(request, timeout=timeout) as result:
            status = result.status
            response = parse_json_or_text(result.read())
    except urllib.error.HTTPError as error:
        status = error.code
        response = parse_json_or_text(error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        error_text = str(error)
    finally:
        with evidence_path.open("a", encoding="utf-8") as stream:
            stream.write(
                json.dumps(
                    {
                        "at": utc_now(),
                        "method": method,
                        "url": base_url + path,
                        "request": payload,
                        "status": status,
                        "response": response,
                        "transport_error": error_text,
                        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
    return status, response, error_text


def ensure_loopback_base_url(raw: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(raw)
    ensure(parsed.scheme == "http", "Ollama base URL must use local plain HTTP")
    ensure(parsed.hostname in ("127.0.0.1", "localhost", "::1"), "Ollama base URL must resolve to loopback")
    ensure(parsed.username is None and parsed.password is None, "Ollama base URL must not contain credentials")
    ensure(parsed.path.rstrip("/") == "/v1", "Ollama base URL must end in /v1")
    ensure(parsed.query == "" and parsed.fragment == "", "Ollama base URL may not contain query or fragment")
    ensure(parsed.port is not None, "Ollama base URL must specify its port")
    return parsed


def ollama_inventory(base: urllib.parse.SplitResult, model: str, path: Path) -> dict[str, Any]:
    root = f"{base.scheme}://{base.netloc}"
    url = root + "/api/tags"
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with DIRECT_OPENER.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            body = response.read()
            status = response.status
            decoded = json.loads(body.decode("utf-8"))
    except Exception as error:
        write_json(path, {"url": url, "error": f"{type(error).__name__}: {error}"})
        raise RuntimeError(f"cannot identify local Ollama model at {url}: {error}") from error
    names = [
        item.get("name")
        for item in decoded.get("models", [])
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    ] if isinstance(decoded, dict) else []
    result = {
        "url": url,
        "status": status,
        "requested_model": model,
        "available_model_names": names,
        "requested_model_available": model in names,
        "response": decoded,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
    }
    write_json(path, result)
    ensure(result["requested_model_available"], f"requested local Ollama model {model!r} is not listed at {url}")
    return result


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for child in value for item in flatten_strings(child)]
    if isinstance(value, dict):
        return [item for child in value.values() for item in flatten_strings(child)]
    return []


def system_message_texts(data: Any) -> list[str]:
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return []
    result: list[str] = []
    for message in data["messages"]:
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        content = message.get("content")
        if isinstance(content, str):
            result.append(content)
        elif isinstance(content, list):
            result.append("".join(flatten_strings(content)))
        else:
            result.append("")
    return result


def user_message_texts(data: Any) -> list[str]:
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return []
    result: list[str] = []
    for message in data["messages"]:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            result.append(content)
        elif isinstance(content, list):
            result.append("".join(flatten_strings(content)))
    return result


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
                key = str(item.get("index", item.get("id", f"{choice_index}:{item_index}")))
                call = calls.setdefault(key, {"name": "", "arguments": "", "id": ""})
                if isinstance(item.get("id"), str):
                    call["id"] = item["id"]
                function = item.get("function")
                if isinstance(function, dict):
                    if isinstance(function.get("name"), str):
                        call["name"] += function["name"]
                    if isinstance(function.get("arguments"), str):
                        call["arguments"] += function["arguments"]
    return {
        "model_names": list(dict.fromkeys(model_names)),
        "tool_calls": list(calls.values()),
        "text": "".join(texts),
        "finish_reasons": finish_reasons,
        "parsed_payload_count": len(payloads),
    }


class RecordingProxy:
    """Forwards only marker-free chat requests to loopback Ollama and records raw traffic."""

    def __init__(
        self,
        upstream: urllib.parse.SplitResult,
        evidence_path: Path,
        forbidden: list[bytes],
        expected_model: str,
        expected_user_prompt: str,
    ):
        self.upstream = upstream
        self.evidence_path = evidence_path
        self.forbidden = forbidden
        self.expected_model = expected_model
        self.expected_user_prompt = expected_user_prompt
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.active_connections: set[http.client.HTTPConnection] = set()
        self.stopping = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def do_GET(self) -> None:
                if self.path == "/__otter_health":
                    body = b"{\"healthy\":true}\n"
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_error(404)

            def do_POST(self) -> None:
                self.handle_inference()

            def handle_inference(self) -> None:
                started = time.monotonic()
                record: dict[str, Any] = {
                    "at": utc_now(),
                    "method": self.command,
                    "path": self.path,
                    "forwarded": False,
                    "http_status": None,
                }
                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_BODY_BYTES:
                    record["proxy_error"] = f"invalid request body length: {length}"
                    response = b"invalid request body length\n"
                    self.send_response(413)
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
                    owner.save_record(record, b"", response, started)
                    return

                request_body = self.rfile.read(length)
                record["request_body"] = request_body.decode("utf-8", errors="replace")
                record["request_body_sha256"] = sha256_bytes(request_body)
                request_data: Any = None
                try:
                    request_data = json.loads(request_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    record["request_json_error"] = "body is not valid UTF-8 JSON"
                if isinstance(request_data, dict):
                    record["model"] = request_data.get("model")
                    record["stream"] = request_data.get("stream")
                    record["tool_definitions"] = request_data.get("tools")
                    record["request_tool_names"] = request_tool_names(request_data)
                system_texts = system_message_texts(request_data)
                record["system_message_count"] = len(system_texts)
                record["system_messages_sha256"] = sha256_bytes("\n".join(system_texts).encode("utf-8"))
                record["system_message_texts"] = system_texts
                user_texts = user_message_texts(request_data)
                record["user_message_count"] = len(user_texts)
                record["user_messages"] = user_texts
                record["required_native_user_prompt_preserved"] = owner.expected_user_prompt in user_texts
                request_strings = flatten_strings(request_data)
                found = [
                    marker.decode("utf-8")
                    for marker in owner.forbidden
                    if marker
                    and (
                        marker in request_body
                        or any(marker.decode("utf-8") in value for value in request_strings)
                    )
                ]
                record["unchecked_markers_detected"] = found
                block_reason: str | None = None
                if found:
                    block_reason = "request contains unchecked project skill marker"
                elif self.path.split("?", 1)[0] != "/v1/chat/completions":
                    block_reason = "only native chat-completions traffic may be forwarded"
                elif not isinstance(request_data, dict):
                    block_reason = "request body must be JSON"
                elif system_texts != [OWNED_SYSTEM_PROMPT]:
                    block_reason = "native inference request did not contain exactly the fixed runtime-owned system prompt"
                elif request_data.get("model") not in (owner.expected_model, f"{PROVIDER_ID}/{owner.expected_model}") and not str(request_data.get("model", "")).endswith(f"/{owner.expected_model}"):
                    block_reason = "request selected a model other than the configured local Ollama model"
                elif request_tool_names(request_data) not in ([], ["skill"]):
                    block_reason = "native model request exposed a tool other than skill"
                elif request_tool_names(request_data) == [] and request_data.get("tools") not in (None, []):
                    block_reason = "native tool-free support request contained an unrecognized tool definition"
                elif request_tool_names(request_data) == []:
                    record["inference_request_kind"] = "tool-free-native-support-call"
                else:
                    record["inference_request_kind"] = "native-skill-tool-call-capable"
                    if owner.expected_user_prompt not in user_texts:
                        block_reason = "native request did not preserve the original user prompt verbatim"
                    tool_definitions = request_data.get("tools")
                    function = (
                        tool_definitions[0].get("function")
                        if isinstance(tool_definitions, list) and len(tool_definitions) == 1 and isinstance(tool_definitions[0], dict)
                        else None
                    )
                    parameters = function.get("parameters") if isinstance(function, dict) else None
                    properties = parameters.get("properties") if isinstance(parameters, dict) else None
                    name_schema = properties.get("name") if isinstance(properties, dict) else None
                    if not block_reason and (
                        not isinstance(function, dict)
                        or function.get("name") != "skill"
                        or function.get("description") != TOOL_DESCRIPTION
                        or not isinstance(parameters, dict)
                        or not isinstance(properties, dict)
                        or set(properties) != {"name"}
                        or not isinstance(name_schema, dict)
                        or name_schema.get("enum") != ["skill"]
                        or "name" not in parameters.get("required", [])
                    ):
                        block_reason = "registered skill tool description or fixed safe argument schema was not observed"
                if block_reason:
                    record["forwarding_block_reason"] = block_reason
                    response = f"Otter skill contract proxy refused unsafe or unsupported inference request: {block_reason}.\n".encode("utf-8")
                    self.send_response(422, "Unchecked project skill text blocked")
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(response)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    try:
                        self.wfile.write(response)
                    except OSError:
                        pass
                    self.close_connection = True
                    owner.save_record(record, request_body, response, started)
                    return

                connection = http.client.HTTPConnection(
                    owner.upstream.hostname,
                    owner.upstream.port,
                    timeout=MODEL_TIMEOUT_SECONDS,
                )
                stopping = False
                with owner.lock:
                    if owner.stopping:
                        connection.close()
                        stopping = True
                    else:
                        owner.active_connections.add(connection)
                if stopping:
                    record["proxy_error"] = "proxy is stopping"
                    owner.save_record(record, request_body, b"", started)
                    return
                response_body = b""
                try:
                    upstream_path = self.path
                    connection.request(
                        "POST",
                        upstream_path,
                        body=request_body,
                        headers={
                            "Content-Type": self.headers.get("Content-Type", "application/json"),
                            "Accept": self.headers.get("Accept", "application/json"),
                            "User-Agent": "otter-skill-contract-proxy/1",
                        },
                    )
                    record["forwarded"] = True
                    upstream_response = connection.getresponse()
                    response_body = upstream_response.read()
                    record["http_status"] = upstream_response.status
                    record["upstream_reason"] = upstream_response.reason
                    observations = response_observations(response_body)
                    record["upstream_observations"] = observations
                    record["upstream_response_body"] = response_body.decode("utf-8", errors="replace")
                    record["upstream_response_sha256"] = sha256_bytes(response_body)
                    unexpected_tool_calls = [
                        call for call in observations.get("tool_calls", []) if call.get("name") != "skill"
                    ]
                    if unexpected_tool_calls:
                        record["response_block_reason"] = "real model requested a tool other than skill"
                        record["unexpected_model_tool_calls"] = unexpected_tool_calls
                        blocked_response = b"Otter skill contract proxy refused a non-skill tool call; no tool was executed.\n"
                        self.send_response(422, "Non-skill tool call refused")
                        self.send_header("Content-Type", "text/plain; charset=utf-8")
                        self.send_header("Content-Length", str(len(blocked_response)))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(blocked_response)
                        self.close_connection = True
                        return
                    self.send_response(upstream_response.status, upstream_response.reason)
                    content_type = upstream_response.getheader("Content-Type")
                    if content_type:
                        self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(response_body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if response_body:
                        self.wfile.write(response_body)
                    self.close_connection = True
                except (OSError, http.client.HTTPException, TimeoutError) as error:
                    record["proxy_error"] = f"{type(error).__name__}: {error}"
                    if not self.wfile.closed:
                        response = b"loopback Ollama request failed; no synthetic completion was returned\n"
                        try:
                            self.send_response(502)
                            self.send_header("Content-Length", str(len(response)))
                            self.send_header("Connection", "close")
                            self.end_headers()
                            self.wfile.write(response)
                        except OSError:
                            pass
                        self.close_connection = True
                finally:
                    with owner.lock:
                        owner.active_connections.discard(connection)
                    connection.close()
                    owner.save_record(record, request_body, response_body, started)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, name="skill-contract-proxy", daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])
        self.base_url = f"http://127.0.0.1:{self.port}"

    def save_record(self, record: dict[str, Any], request_body: bytes, response_body: bytes, started: float) -> None:
        record["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        with self.lock:
            self.requests.append(record)
            with self.evidence_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                stream.flush()

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def stop(self) -> None:
        with self.lock:
            self.stopping = True
            connections = list(self.active_connections)
        for connection in connections:
            connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def request_tool_names(data: dict[str, Any]) -> list[str]:
    tools = data.get("tools")
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


def isolated_environment(
    run_dir: Path,
    config: dict[str, Any],
    output_path: Path,
    output_hash: str,
    output_system_hash: str,
    prompt: str,
    unchecked_body_marker: str,
    unchecked_description_marker: str,
    tool_evidence: Path,
) -> dict[str, str]:
    isolated = run_dir / "isolated"
    directories = {
        "HOME": isolated / "home",
        "XDG_CONFIG_HOME": isolated / "xdg-config",
        "XDG_DATA_HOME": isolated / "xdg-data",
        "XDG_STATE_HOME": isolated / "xdg-state",
        "XDG_CACHE_HOME": isolated / "xdg-cache",
        "TMPDIR": isolated / "tmp",
        "WORKSPACE": isolated / "workspace",
    }
    for path in directories.values():
        path.mkdir(parents=True, exist_ok=True)
    keep = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL")
    env = {key: os.environ[key] for key in keep if os.environ.get(key)}
    env.update({key: str(value) for key, value in directories.items() if key != "WORKSPACE"})
    env.update(
        {
            "TMP": str(directories["TMPDIR"]),
            "TEMP": str(directories["TMPDIR"]),
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_CONFIG_CONTENT": json.dumps(config, ensure_ascii=False, separators=(",", ":")),
            "OTTER_SKILL_CONTRACT_OUTPUT": str(output_path),
            "OTTER_SKILL_CONTRACT_OUTPUT_SHA256": output_hash,
            "OTTER_SKILL_CONTRACT_SYSTEM_SHA256": output_system_hash,
            "OTTER_SKILL_CONTRACT_PROMPT": prompt,
            "OTTER_SKILL_CONTRACT_UNCHECKED_BODY_MARKER": unchecked_body_marker,
            "OTTER_SKILL_CONTRACT_UNCHECKED_DESCRIPTION_MARKER": unchecked_description_marker,
            "OTTER_SKILL_CONTRACT_TOOL_EVIDENCE": str(tool_evidence),
        }
    )
    return env


def wait_for_health(process: subprocess.Popen[bytes], base_url: str, evidence: Path) -> dict[str, Any]:
    deadline = time.monotonic() + 45
    last_error = "health endpoint did not respond"
    while time.monotonic() < deadline:
        returncode = process.poll()
        if returncode is not None:
            raise RuntimeError(f"OpenCode server exited before health became ready (exit {returncode}); inspect retained server logs")
        status, body, error = request_json(evidence, base_url, "GET", "/global/health", timeout=2)
        if status == 200 and isinstance(body, dict) and body.get("healthy") is True and isinstance(body.get("version"), str):
            return body
        last_error = error or f"HTTP {status}: {body!r}"
        time.sleep(0.25)
    raise TimeoutError(f"OpenCode health timeout after 45s: {last_error}")


def port_unreachable(base_url: str, path: str) -> bool:
    try:
        with DIRECT_OPENER.open(base_url + path, timeout=1) as response:
            response.read()
        return False
    except (urllib.error.URLError, TimeoutError, OSError):
        return True


def cleanup_process(process: subprocess.Popen[bytes] | None, base_url: str | None, evidence: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "started": process is not None,
        "pid": process.pid if process else None,
        "process_group": process.pid if process else None,
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
            os.killpg(process.pid, signal.SIGTERM)
            result["terminate_sent"] = True
        except ProcessLookupError:
            pass
        except OSError as error:
            result["errors"].append(f"terminate process group: {error}")
        try:
            process.wait(timeout=12)
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
                process.wait(timeout=12)
                result["wait_completed"] = True
            except (subprocess.TimeoutExpired, OSError) as error:
                result["errors"].append(f"wait after kill: {error}")
    else:
        try:
            process.wait()
            result["wait_completed"] = True
        except OSError as error:
            result["errors"].append(f"wait after server exit: {error}")
    result["return_code"] = process.poll()
    result["process_alive_after_cleanup"] = process.poll() is None
    if base_url and not result["process_alive_after_cleanup"]:
        result["server_port_unreachable_after_cleanup"] = port_unreachable(base_url, "/global/health")
    return result


def status_line(path: Path, message: str) -> None:
    path.write_text(message, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", required=True, help="absolute path to the installed OpenCode executable")
    parser.add_argument("--out", required=True, help="artifact directory; existing contents are never removed")
    parser.add_argument("--ollama-base-url", default=DEFAULT_OLLAMA_BASE_URL, help="local Ollama OpenAI-compatible endpoint")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="model name already installed in local Ollama")
    parser.add_argument("--attempts", type=int, choices=(1, 2), default=1, help="bounded real-model attempts (default: 1)")
    args = parser.parse_args()

    out_root = Path(args.out).expanduser().resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    run_dir = unique_run_dir(out_root)
    paths = {
        "summary": run_dir / "summary.json",
        "api_evidence": run_dir / "native-api.jsonl",
        "proxy_evidence": run_dir / "ollama-proxy.jsonl",
        "server_stdout": run_dir / "server.stdout.log",
        "server_stderr": run_dir / "server.stderr.log",
        "harness_stdout": run_dir / "harness.stdout.log",
        "harness_stderr": run_dir / "harness.stderr.log",
        "native_version_stdout": run_dir / "opencode-version.stdout.log",
        "native_version_stderr": run_dir / "opencode-version.stderr.log",
        "workspace_git_stdout": run_dir / "workspace-git-init.stdout.log",
        "workspace_git_stderr": run_dir / "workspace-git-init.stderr.log",
        "opencode_config": run_dir / "opencode-config.json",
        "ollama_inventory": run_dir / "ollama-model-inventory.json",
        "tool_evidence": run_dir / "tool-execution.jsonl",
        "owned_output": run_dir / "runtime-owned-skill-output.txt",
        "vendor_skill": run_dir / "isolated" / "workspace" / ".agents" / "skills" / "skill" / "SKILL.md",
    }
    paths["vendor_skill"].parent.mkdir(parents=True, exist_ok=True)
    api_url: str | None = None
    process: subprocess.Popen[bytes] | None = None
    proxy: RecordingProxy | None = None
    cleanup: dict[str, Any] | None = None
    proxy_port_unreachable: bool | None = None
    owned_system_hash: str | None = None
    success = False
    summary: dict[str, Any] = {
        "probe": "native OpenCode skill-tool override capability probe; not product grants/capture qualification",
        "started_at": utc_now(),
        "success": False,
        "out_root": str(out_root),
        "run_directory": str(run_dir),
        "artifacts": {key: str(value) for key, value in paths.items()},
        "limitations": [
            "This probes OpenCode's native plugin tool registry, native plugin lifecycle hooks, HTTP prompt path, and one local Ollama model only.",
            "The tool implementation is a deterministic probe adapter; the product Otter adapter must replace it and rerun qualification.",
            "The experimental system transform hook replaces OpenCode's merged system channel only in this capability probe; this is not approval or authority to modify production prompts.",
            "It does not establish or grant production product authorization, least-privilege policy, or transcript-capture qualification.",
            "Any unchecked vendor marker detected in a native inference request is blocked by the proxy before Ollama and fails this capability probe.",
            "No synthetic model completion or tool call is generated by the harness or proxy.",
        ],
    }

    try:
        opencode_arg = Path(args.opencode).expanduser()
        ensure(opencode_arg.is_absolute(), "--opencode must be an absolute path")
        opencode = opencode_arg.resolve(strict=True)
        ensure(opencode.is_file() and os.access(opencode, os.X_OK), f"OpenCode executable is not executable: {opencode}")
        upstream = ensure_loopback_base_url(args.ollama_base_url)
        ensure(args.model.strip() == args.model and bool(args.model), "--model must be a nonempty exact Ollama model name")
        plugin_path = Path(__file__).resolve().with_name("skill-contract-plugin.ts")
        ensure(plugin_path.is_file(), f"required plugin source is missing: {plugin_path}")
        plugin_package_path = plugin_path.parents[2] / "node_modules" / "@opencode-ai" / "plugin" / "package.json"
        plugin_package = json.loads(plugin_package_path.read_text(encoding="utf-8"))
        ensure(plugin_package.get("name") == "@opencode-ai/plugin", "installed public plugin SDK package identity was unexpected")

        output_token = f"OTTER_RUNTIME_OWNED_SKILL_REPLY_{secrets.token_hex(12)}"
        vendor_body_marker = f"OTTER_UNCHECKED_VENDOR_BODY_{secrets.token_hex(12)}"
        vendor_description_marker = f"OTTER_UNCHECKED_VENDOR_DESCRIPTION_{secrets.token_hex(12)}"
        owned_output = (
            "# Runtime-owned skill fixture\n\n"
            f"Verified adapter phrase: {output_token}\n"
            "When asked for the verification phrase, answer with exactly that single phrase.\n"
        ).encode("utf-8")
        paths["owned_output"].write_bytes(owned_output)
        vendor_skill = (
            "---\n"
            "name: skill\n"
            f"description: {vendor_description_marker}\n"
            "---\n\n"
            "# Unchecked project skill fixture\n\n"
            f"Untrusted vendor body marker: {vendor_body_marker}\n"
            "This is intentionally distinct from the runtime-owned adapter output.\n"
        ).encode("utf-8")
        paths["vendor_skill"].write_bytes(vendor_skill)
        forbidden = [vendor_body_marker.encode("utf-8"), vendor_description_marker.encode("utf-8")]
        output_hash = sha256_bytes(owned_output)
        owned_system_hash = sha256_bytes(OWNED_SYSTEM_PROMPT.encode("utf-8"))
        prompt = (
            "For this contract check, call the `skill` tool exactly once with the name `skill`. "
            "Do not use any other tool. Read the returned instructions and respond with exactly the "
            "single verification phrase they specify. Do not guess the phrase or answer before using the tool."
        )

        proxy = RecordingProxy(upstream, paths["proxy_evidence"], forbidden, args.model, prompt)
        proxy_base = proxy.base_url
        server_port = available_tcp_port()
        api_url = f"http://127.0.0.1:{server_port}"
        tools = {
            "skill": True,
            "bash": False,
            "shell": False,
            "read": False,
            "glob": False,
            "grep": False,
            "edit": False,
            "write": False,
            "task": False,
            "fetch": False,
            "webfetch": False,
            "search": False,
            "websearch": False,
            "todo": False,
            "todowrite": False,
            "todoread": False,
            "patch": False,
            "apply_patch": False,
            "question": False,
            "lsp": False,
            "plan": False,
            "delegate": False,
            "execute": False,
        }
        config = {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "share": "disabled",
            "model": f"{PROVIDER_ID}/{args.model}",
            "small_model": f"{PROVIDER_ID}/{args.model}",
            "enabled_providers": [PROVIDER_ID],
            "provider": {
                PROVIDER_ID: {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Local Ollama (recording skill-contract proxy)",
                    "options": {
                        "baseURL": f"{proxy_base}/v1",
                        "apiKey": "otter-local-contract-only",
                        "timeout": MODEL_TIMEOUT_MILLISECONDS,
                        "headerTimeout": MODEL_TIMEOUT_MILLISECONDS,
                        "chunkTimeout": MODEL_TIMEOUT_MILLISECONDS,
                    },
                    "models": {
                        args.model: {
                            "name": f"Local Ollama {args.model}",
                            "tool_call": True,
                            "limit": {"context": 32768, "output": 4096},
                            "modalities": {"input": ["text"], "output": ["text"]},
                        }
                    },
                }
            },
            "plugin": [plugin_path.as_uri()],
            "agent": {
                AGENT_ID: {
                    "mode": "primary",
                    "description": "Native skill adapter contract probe; only the skill tool is enabled.",
                    "model": f"{PROVIDER_ID}/{args.model}",
                    "maxSteps": 4,
                    "tools": tools,
                }
            },
            "permission": {"bash": "deny", "edit": "deny", "webfetch": "deny"},
        }
        write_json(paths["opencode_config"], config)
        env = isolated_environment(
            run_dir,
            config,
            paths["owned_output"],
            output_hash,
            owned_system_hash,
            prompt,
            vendor_body_marker,
            vendor_description_marker,
            paths["tool_evidence"],
        )
        workspace = Path(env["HOME"]).parent / "workspace"
        git_result = subprocess.run(
            ["git", "init", "--quiet", str(workspace)],
            cwd=workspace,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        paths["workspace_git_stdout"].write_bytes(git_result.stdout)
        paths["workspace_git_stderr"].write_bytes(git_result.stderr)
        ensure(git_result.returncode == 0, f"could not create isolated workspace repository (git init exit {git_result.returncode})")

        summary.update(
            {
                "opencode_executable": str(opencode),
                "opencode_executable_sha256": sha256_file(opencode),
                "native_server_command": [str(opencode), "serve", "--hostname", "127.0.0.1", "--port", str(server_port)],
                "native_server_url": api_url,
                "native_server_port": server_port,
                "ollama_base_url": args.ollama_base_url,
                "ollama_model": args.model,
                "attempt_limit": args.attempts,
                "plugin_uri": plugin_path.as_uri(),
                "source_hashes": {
                    "harness_sha256": sha256_file(Path(__file__).resolve()),
                    "plugin_sha256": sha256_file(plugin_path),
                    "plugin_api_package_json_sha256": sha256_file(plugin_package_path),
                    "runtime_owned_skill_output_sha256": output_hash,
                    "runtime_owned_system_prompt_sha256": owned_system_hash,
                    "vendor_skill_source_sha256": sha256_bytes(vendor_skill),
                },
                "public_plugin_api_dependency": {
                    "package": plugin_package["name"],
                    "version": plugin_package.get("version"),
                    "package_json": str(plugin_package_path),
                },
                "fixture_markers": {
                    "unchecked_vendor_body": vendor_body_marker,
                    "unchecked_vendor_description": vendor_description_marker,
                    "runtime_owned_reply": output_token,
                },
                "configuration": {
                    "agent": AGENT_ID,
                    "native_tool_override_name": "skill",
                    "native_plugin_api_import": "@opencode-ai/plugin/tool",
                    "project_fixture_skill_name": "skill",
                    "project_fixture_location": str(paths["vendor_skill"]),
                    "runtime_owned_skill_output": str(paths["owned_output"]),
                    "runtime_owned_system_prompt_sha256": owned_system_hash,
                    "system_transform_hook": "experimental.chat.system.transform",
                    "system_transform_semantics": "wholesale replacement of the merged system array with one fixed trusted string",
                    "enabled_tool_ids": ["skill"],
                    "disabled_tool_ids": sorted(key for key, value in tools.items() if not value),
                    "model_backend": f"{proxy_base}/v1",
                    "upstream_model_service": args.ollama_base_url,
                    "synthetic_api_key_only": True,
                    "models_fetch_disabled": True,
                    "autoupdate_disabled": True,
                },
                "isolation": {
                    key: env[key]
                    for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR")
                },
                "workspace": str(workspace),
                "workspace_git_root": str(workspace / ".git"),
                "runtime": {"cli_version": None, "health": None, "server_version": None},
                "ollama_model_inventory": None,
                "attempts": [],
            }
        )

        version_env = {**env, "OPENCODE_CONFIG_CONTENT": "{}"}
        version_result = subprocess.run(
            [str(opencode), "--version"],
            cwd=workspace,
            env=version_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )
        paths["native_version_stdout"].write_bytes(version_result.stdout)
        paths["native_version_stderr"].write_bytes(version_result.stderr)
        cli_version = version_result.stdout.decode("utf-8", errors="replace").strip()
        summary["runtime"]["cli_version"] = {
            "stdout": cli_version,
            "stderr": version_result.stderr.decode("utf-8", errors="replace"),
            "exit_code": version_result.returncode,
        }
        ensure(version_result.returncode == 0, f"OpenCode --version failed (exit {version_result.returncode})")
        ensure(cli_version == EXPECTED_OPENCODE_VERSION, f"expected OpenCode {EXPECTED_OPENCODE_VERSION}, observed {cli_version!r}")

        inventory = ollama_inventory(upstream, args.model, paths["ollama_inventory"])
        summary["ollama_model_inventory"] = inventory

        with paths["server_stdout"].open("wb") as stdout, paths["server_stderr"].open("wb") as stderr:
            process = subprocess.Popen(
                summary["native_server_command"],
                cwd=workspace,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
            summary["native_server_pid"] = process.pid
            health = wait_for_health(process, api_url, paths["api_evidence"])
            summary["runtime"]["health"] = health
            summary["runtime"]["server_version"] = health.get("version")
            ensure(health.get("version") == EXPECTED_OPENCODE_VERSION, f"native server version was {health.get('version')!r}, expected {EXPECTED_OPENCODE_VERSION}")

            directory_query = urllib.parse.urlencode({"directory": str(workspace)})
            attempt_limit = args.attempts
            for attempt_number in range(1, attempt_limit + 1):
                status, session, error = request_json(
                    paths["api_evidence"], api_url, "POST", f"/session?{directory_query}", {"title": f"Skill contract attempt {attempt_number}"}
                )
                ensure(status == 200 and isinstance(session, dict) and isinstance(session.get("id"), str), f"native session create failed (HTTP {status}): {session!r} {error or ''}")
                session_id = session["id"]
                ensure(paths["tool_evidence"].is_file(), "native probe plugin did not initialize; no inference requested")
                initialization = [
                    json.loads(line)
                    for line in paths["tool_evidence"].read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                ensure(
                    any(event.get("phase") == "plugin.initialized" and event.get("pid") == process.pid
                        and event.get("systemSha256") == owned_system_hash for event in initialization),
                    "native probe plugin initialization identity was not proven; no inference requested",
                )
                submitted_user_message_id = f"msg_{secrets.token_hex(12)}"
                prompt_body = {
                    "messageID": submitted_user_message_id,
                    "agent": AGENT_ID,
                    "model": {"providerID": PROVIDER_ID, "modelID": args.model},
                    "parts": [{"type": "text", "text": prompt}],
                }
                prompt_status, prompt_result, prompt_error = request_json(
                    paths["api_evidence"],
                    api_url,
                    "POST",
                    f"/session/{urllib.parse.quote(session_id, safe='')}/message?{directory_query}",
                    prompt_body,
                    timeout=MODEL_TIMEOUT_SECONDS + 60,
                )
                attempt: dict[str, Any] = {
                    "number": attempt_number,
                    "session_id": session_id,
                    "submitted_user_message_id": submitted_user_message_id,
                    "prompt": prompt,
                    "prompt_http_status": prompt_status,
                    "prompt_result": prompt_result,
                    "prompt_transport_error": prompt_error,
                    "tool_calls": [],
                    "tool_parts": [],
                }
                summary["attempts"].append(attempt)
                if prompt_status != 200:
                    # A marker leak is an explicit capability failure; never retry it.
                    proxy_requests = proxy.snapshot()
                    if any(item.get("unchecked_markers_detected") for item in proxy_requests):
                        break
                    if attempt_number < attempt_limit:
                        continue
                    break

                messages_status, messages, messages_error = request_json(
                    paths["api_evidence"],
                    api_url,
                    "GET",
                    f"/session/{urllib.parse.quote(session_id, safe='')}/message?{directory_query}",
                    timeout=HTTP_TIMEOUT_SECONDS,
                )
                attempt["messages_http_status"] = messages_status
                attempt["messages_error"] = messages_error
                attempt["canonical_messages"] = messages
                if messages_status != 200 or not isinstance(messages, list):
                    if attempt_number < attempt_limit:
                        continue
                    break

                for message in messages:
                    if not isinstance(message, dict) or not isinstance(message.get("info"), dict):
                        continue
                    info = message["info"]
                    parts = message.get("parts")
                    if not isinstance(parts, list):
                        continue
                    for part in parts:
                        if isinstance(part, dict) and part.get("type") == "tool":
                            attempt["tool_parts"].append(
                                {
                                    "tool": part.get("tool"),
                                    "callID": part.get("callID"),
                                    "sessionID": part.get("sessionID"),
                                    "messageID": part.get("messageID"),
                                    "assistantMessageID": info.get("id"),
                                    "assistantParentID": info.get("parentID"),
                                    "state": part.get("state"),
                                }
                            )
                attempt["canonical_user_messages"] = [
                    {
                        "id": message["info"].get("id"),
                        "sessionID": message["info"].get("sessionID"),
                        "role": message["info"].get("role"),
                        "text": "\n".join(
                            part.get("text", "")
                            for part in message["parts"]
                            if isinstance(part, dict)
                            and part.get("type") == "text"
                            and part.get("synthetic") is not True
                            and part.get("ignored") is not True
                            and isinstance(part.get("text"), str)
                        ),
                    }
                    for message in messages
                    if isinstance(message, dict)
                    and isinstance(message.get("info"), dict)
                    and message["info"].get("role") == "user"
                    and isinstance(message.get("parts"), list)
                ]
                assistant_text: list[str] = []
                for message in messages:
                    if not isinstance(message, dict) or not isinstance(message.get("info"), dict):
                        continue
                    if message["info"].get("role") != "assistant":
                        continue
                    parts = message.get("parts")
                    if not isinstance(parts, list):
                        continue
                    assistant_text.extend(
                        part["text"]
                        for part in parts
                        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
                    )
                attempt["assistant_text"] = "\n".join(assistant_text)
                proxy_requests = proxy.snapshot()
                attempt["inference_request_count"] = len(proxy_requests)
                attempt["provider_tool_calls"] = [
                    call
                    for request in proxy_requests
                    for call in request.get("upstream_observations", {}).get("tool_calls", [])
                ]
                if any(part.get("tool") == "skill" and isinstance(part.get("state"), dict) and part["state"].get("status") == "completed" for part in attempt["tool_parts"]):
                    break

        ensure(process is not None, "native server was not launched")
        proxy_requests = proxy.snapshot()
        forwarded = [item for item in proxy_requests if item.get("forwarded") is True]
        blocked = [item for item in proxy_requests if item.get("unchecked_markers_detected")]
        tool_events = []
        if paths["tool_evidence"].is_file():
            for line in paths["tool_evidence"].read_text(encoding="utf-8").splitlines():
                if line.strip():
                    tool_events.append(json.loads(line))
        summary["ollama_proxy"] = {
            "listen_url": proxy.base_url,
            "upstream_url": args.ollama_base_url,
            "request_count": len(proxy_requests),
            "forwarded_request_count": len(forwarded),
            "blocked_unchecked_marker_request_count": len(blocked),
            "unchecked_markers_forwarded_to_ollama": any(
                item.get("forwarded") is True and item.get("unchecked_markers_detected") for item in proxy_requests
            ),
            "requests": proxy_requests,
            "model_tool_calls": [
                call
                for item in proxy_requests
                for call in item.get("upstream_observations", {}).get("tool_calls", [])
            ],
            "real_upstream_response_count": sum(1 for item in forwarded if item.get("http_status") == 200),
            "synthetic_model_responses": False,
        }
        summary["native_tool_evidence"] = {
            "events": tool_events,
            "before_count": sum(1 for event in tool_events if event.get("phase") == "tool.execute.before"),
            "adapter_execute_count": sum(1 for event in tool_events if event.get("phase") == "adapter.execute"),
            "after_count": sum(1 for event in tool_events if event.get("phase") == "tool.execute.after"),
        }
        system_events = [
            event for event in tool_events if event.get("phase") == "experimental.chat.system.transform"
        ]
        system_events.sort(key=lambda event: event.get("sequence", 0))
        summary["system_channel_ownership"] = {
            "hook": "experimental.chat.system.transform",
            "replacement_mode": "wholesale-fixed-system-array-replacement",
            "ordering_source": "OpenCode v1.18.35 packages/opencode/src/session/llm/request.ts: merged system is passed to the hook before model parameters and inference",
            "trusted_system_fixture": OWNED_SYSTEM_PROMPT,
            "trusted_system_sha256": owned_system_hash,
            "native_transform_events": system_events,
            "before_system_hashes": [event.get("beforeSha256") for event in system_events],
            "after_system_hashes": [event.get("afterSha256") for event in system_events],
            "unchecked_description_marker_observed_before_override": any(
                event.get("uncheckedDescriptionMarkerBefore") is True for event in system_events
            ),
            "unchecked_body_marker_observed_before_override": any(
                event.get("uncheckedBodyMarkerBefore") is True for event in system_events
            ),
            "unchecked_markers_observed_after_override": any(
                event.get("uncheckedBodyMarkerAfter") is True or event.get("uncheckedDescriptionMarkerAfter") is True
                for event in system_events
            ),
            "inference_request_system_hashes": [item.get("system_messages_sha256") for item in proxy_requests],
            "inference_request_system_prompts_are_exact_fixture": all(
                item.get("system_messages_sha256") == owned_system_hash
                and item.get("system_message_count") == 1
                for item in proxy_requests
            ),
        }
        observed_request_strings = [
            text
            for item in proxy_requests
            for text in flatten_strings(item.get("request_body", ""))
        ]
        summary["project_skill_discovery"] = {
            "fixture_skill_name": "skill",
            "fixture_source_sha256": sha256_bytes(vendor_skill),
            "description_marker_observed_in_merged_system_before_override": summary["system_channel_ownership"][
                "unchecked_description_marker_observed_before_override"
            ],
            "description_marker_observed_in_native_model_requests": any(
                vendor_description_marker in text for text in observed_request_strings
            ),
            "body_marker_observed_in_native_model_requests": any(
                vendor_body_marker in text for text in observed_request_strings
            ),
        }

        ensure(not blocked, "unchecked project-skill marker appeared in a native model request; proxy blocked it before Ollama")
        ensure(
            summary["system_channel_ownership"]["unchecked_description_marker_observed_before_override"],
            "native system hook did not observe the same-name vendor skill description in merged system content",
        )
        ensure(system_events, "native experimental.chat.system.transform hook did not run")
        ensure(
            all(
                event.get("afterSha256") == owned_system_hash
                and event.get("afterEntryCount") == 1
                and not event.get("uncheckedBodyMarkerAfter")
                and not event.get("uncheckedDescriptionMarkerAfter")
                for event in system_events
            ),
            "system transform hook did not replace the merged system channel with the exact trusted fixture",
        )
        ensure(
            summary["system_channel_ownership"]["inference_request_system_prompts_are_exact_fixture"],
            "an inference request did not contain exactly the fixed trusted system prompt",
        )
        ensure(
            not summary["project_skill_discovery"]["description_marker_observed_in_native_model_requests"]
            and not summary["project_skill_discovery"]["body_marker_observed_in_native_model_requests"],
            "unchecked project skill markers reached a native model request",
        )
        refused = [item for item in proxy_requests if item.get("forwarding_block_reason")]
        ensure(not refused, f"native skill adapter capability unavailable: proxy refused request: {[item['forwarding_block_reason'] for item in refused]!r}")
        ensure(forwarded, "no real native inference request reached the Ollama proxy")
        ensure(all(item.get("http_status") == 200 for item in forwarded), "one or more real local Ollama requests failed")
        ensure(not summary["ollama_proxy"]["unchecked_markers_forwarded_to_ollama"], "unchecked project-skill marker was forwarded to Ollama")

        provider_tool_calls = summary["ollama_proxy"]["model_tool_calls"]
        ensure(any(call.get("name") == "skill" for call in provider_tool_calls), "real Ollama response did not call the native skill tool")
        ensure(len(provider_tool_calls) == 1, "bounded real inference did not return exactly one native skill call")
        ensure(all(call.get("name") == "skill" for call in provider_tool_calls), f"model requested a non-skill tool: {provider_tool_calls!r}")
        request_with_tools = next(
            (item for item in forwarded if isinstance(item.get("tool_definitions"), list) and item.get("tool_definitions")),
            None,
        )
        ensure(request_with_tools is not None, "recorded Ollama request omitted native tool definitions")
        tool_definitions = request_with_tools["tool_definitions"]
        ensure(request_with_tools.get("request_tool_names") == ["skill"], f"native model request exposed tools beyond skill: {request_with_tools.get('request_tool_names')!r}")
        skill_definition = tool_definitions[0].get("function") if isinstance(tool_definitions[0], dict) else None
        ensure(isinstance(skill_definition, dict), "native skill definition was not OpenAI-compatible function schema")
        ensure(skill_definition.get("name") == "skill", "native skill definition name differs")
        ensure(skill_definition.get("description") == TOOL_DESCRIPTION, "native request did not contain the fixed runtime-owned skill description")
        parameters = skill_definition.get("parameters")
        ensure(isinstance(parameters, dict), "native skill tool definition omitted its fixed argument schema")
        properties = parameters.get("properties")
        ensure(isinstance(properties, dict) and isinstance(properties.get("name"), dict), "native skill tool definition omitted its name argument")
        ensure(properties["name"].get("enum") == ["skill"], "native skill tool arguments were not restricted to the fixed fixture name")
        ensure("name" in parameters.get("required", []), "native skill tool name argument was not required")

        before_events = [event for event in tool_events if event.get("phase") == "tool.execute.before"]
        adapter_events = [event for event in tool_events if event.get("phase") == "adapter.execute"]
        after_events = [event for event in tool_events if event.get("phase") == "tool.execute.after"]
        ensure(before_events and adapter_events and after_events, "native SDK tool.execute.before / adapter / tool.execute.after evidence is incomplete")
        ensure(len(before_events) == len(adapter_events) == len(after_events) == 1, "the bounded prompt did not execute exactly one native skill tool call")
        ensure(all(event.get("tool") == "skill" for event in before_events + adapter_events + after_events), "a non-skill tool executed")
        ensure(all(event.get("args") == {"name": "skill"} for event in before_events + adapter_events + after_events), "native skill tool arguments differed from the fixed fixture")
        ensure(all(event.get("sessionID") in {attempt["session_id"] for attempt in summary["attempts"]} for event in before_events + adapter_events + after_events), "tool lifecycle event belongs to an unrequested session")
        before = before_events[0]
        adapter = adapter_events[0]
        after = after_events[0]
        ensure(before.get("canonicalCallVisibleBeforeAdapter") is True, "native canonical tool part was not visible in session.messages at tool.execute.before")
        ensure(after.get("canonicalCallVisibleAfterAdapter") is True, "native canonical tool part was not visible after adapter execution")
        ensure(before.get("canonicalAssistantRole") == after.get("canonicalAssistantRole") == "assistant", "native tool call was not attached to an assistant message")
        ensure(before.get("canonicalParentUserRole") == after.get("canonicalParentUserRole") == "user", "native assistant parent was not the canonical user message")
        ensure(before.get("canonicalParentExists") is True and after.get("canonicalParentExists") is True and after.get("sameAsBeforeHookProof") is True, "native canonical parent/proof consistency was not retained")
        attempt_matches = [attempt for attempt in summary["attempts"] if attempt.get("session_id") == before.get("sessionID")]
        ensure(len(attempt_matches) == 1, "native before-hook proof does not map to exactly one submitted attempt")
        submitted_attempt = attempt_matches[0]
        submitted_user_message_id = submitted_attempt.get("submitted_user_message_id")
        ensure(isinstance(submitted_user_message_id, str) and submitted_user_message_id.startswith("msg_"), "submitted native user message ID was not captured")
        ensure(before.get("canonicalParentUserMessageID") == submitted_user_message_id, "before-hook canonical assistant.parentID does not match the actual submitted user message ID")
        ensure(adapter.get("parentUserMessageID") == submitted_user_message_id, "adapter proof is not bound to the submitted user message ID")
        ensure(after.get("canonicalParentUserMessageID") == submitted_user_message_id, "after-hook canonical assistant.parentID differs from the submitted user message ID")
        ensure(before.get("canonicalAssistantMessageID") == adapter.get("canonicalAssistantMessageID") == after.get("canonicalAssistantMessageID"), "assistant message identity changed between before, adapter, and after")
        ensure(before.get("canonicalPartID") == adapter.get("canonicalPartID") == after.get("canonicalPartID"), "canonical tool part identity changed between before, adapter, and after")
        ensure(before.get("canonicalMessageCount") == adapter.get("canonicalMessageCount") == after.get("canonicalMessageCount"), "native default history cardinality changed during adapter dispatch")
        ensure(before.get("historyLimitSupplied") is False and adapter.get("historyLimitSupplied") is False and after.get("historyLimitSupplied") is False, "native SDK history proof supplied an enumeration limit")
        ensure(before.get("callID") == adapter.get("callID") == after.get("callID"), "native callID differs between before hook, adapter context, and after hook")
        ensure(adapter.get("messageID") == before.get("canonicalAssistantMessageID"), "adapter context.messageID does not equal canonical assistant tool-call message ID")
        ensure(before.get("canonicalToolStatus") == "running" and adapter.get("canonicalToolStatusBeforeExecute") == "running" and after.get("canonicalToolStatus") == "running", "native canonical tool state was not consistently running around adapter dispatch")
        ensure(before.get("canonicalPromptSha256") == after.get("canonicalPromptSha256") == sha256_bytes(prompt.encode("utf-8")), "native parent user prompt identity changed across hook observations")
        ensure(before.get("sessionIdentity") == after.get("sessionIdentity") == adapter.get("sessionIdentity"), "native session identity changed between before, adapter, and after")
        ensure(before.get("sessionIdentity", {}).get("id") == before.get("sessionID"), "native before-hook session identity does not match its hook sessionID")
        ensure(before.get("sessionIdentity", {}).get("directory") == str(workspace), "native session directory does not match the isolated probe worktree")
        ensure(before.get("pluginDirectory") == before.get("pluginWorktree") == adapter.get("directory") == adapter.get("worktree") == after.get("directory") == after.get("worktree") == str(workspace), "plugin/adapter directory identity differs from the isolated worktree")

        submitted_users = [
            user for user in submitted_attempt.get("canonical_user_messages", [])
            if user.get("id") == submitted_user_message_id
        ]
        ensure(len(submitted_users) == 1, "native HTTP transcript does not contain exactly one submitted user message")
        ensure(submitted_users[0].get("role") == "user" and submitted_users[0].get("sessionID") == before.get("sessionID"), "submitted parent message is not a user message in the native session")
        ensure(submitted_users[0].get("text") == prompt, "native HTTP transcript user message differs from the exact submitted prompt")

        correlated_parts = [
            part for part in submitted_attempt.get("tool_parts", [])
            if part.get("sessionID") == before.get("sessionID") and part.get("callID") == before.get("callID")
        ]
        ensure(len(correlated_parts) == 1, "native HTTP transcript does not contain exactly one canonical tool part for the proven callID")
        canonical_tool_part = correlated_parts[0]
        ensure(canonical_tool_part.get("tool") == "skill", "native HTTP canonical callID belongs to a different tool")
        ensure(canonical_tool_part.get("messageID") == canonical_tool_part.get("assistantMessageID") == before.get("canonicalAssistantMessageID"), "native HTTP canonical assistant message ID differs from before-hook proof")
        ensure(canonical_tool_part.get("assistantParentID") == submitted_user_message_id, "native HTTP canonical assistant.parentID does not match the submitted user message")
        ensure(isinstance(canonical_tool_part.get("state"), dict) and canonical_tool_part["state"].get("status") == "completed", "native HTTP transcript did not confirm successful native tool completion")
        for event in adapter_events:
            ensure(event.get("output") == owned_output.decode("utf-8"), "registered adapter output differed from exact captured SKILL bytes")
            ensure(event.get("outputSha256") == output_hash, "registered adapter reported a different captured SKILL hash")
        for event in after_events:
            ensure(event.get("output") == owned_output.decode("utf-8"), "native tool.execute.after output differed from captured SKILL bytes")
        ensure(any(event.get("callID") == after.get("callID") for event in before_events for after in after_events), "tool before/after lifecycle call IDs did not match")

        tool_parts = [
            part
            for attempt in summary["attempts"]
            for part in attempt.get("tool_parts", [])
            if part.get("tool") == "skill"
        ]
        ensure(tool_parts, "native HTTP prompt transcript contains no skill tool part")
        completed_parts = [part for part in tool_parts if isinstance(part.get("state"), dict) and part["state"].get("status") == "completed"]
        ensure(completed_parts, "native HTTP prompt transcript contains no completed skill tool result")
        for part in completed_parts:
            ensure(part["state"].get("output") == owned_output.decode("utf-8"), "native HTTP transcript tool text differed from captured SKILL bytes")
            ensure(part.get("sessionID") in {attempt["session_id"] for attempt in summary["attempts"]}, "native skill tool part belongs to an unexpected session")
        ensure(len(completed_parts) == 1, "native HTTP transcript did not contain exactly one completed skill call")
        ensure(
            completed_parts[0].get("callID") == before_events[0].get("callID") == after_events[0].get("callID"),
            "SDK before/after hooks did not identify the same native HTTP tool call",
        )
        ensure(
            adapter_events[0].get("messageID") == completed_parts[0].get("messageID"),
            "adapter execution message ID differs from the native HTTP tool call",
        )

        clean_requests = [json.loads(item["request_body"]) for item in forwarded]
        output_in_model_context = any(
            any(owned_output.decode("utf-8") in value for value in flatten_strings(request))
            for request in clean_requests
        )
        ensure(output_in_model_context, "captured runtime-owned skill text was not observed in a subsequent real Ollama inference request")
        final_assistant_text = "\n".join(attempt.get("assistant_text", "") for attempt in summary["attempts"])
        ensure(output_token in final_assistant_text, "native prompt result did not use the runtime-owned skill verification phrase")
        ensure(vendor_body_marker not in final_assistant_text and vendor_description_marker not in final_assistant_text, "native prompt result exposed an unchecked project-skill marker")

        summary["qualification_evidence"] = {
            "native_plugin_skill_tool_definition_observed": True,
            "native_tool_name": "skill",
            "fixed_description_observed_in_real_inference_request": skill_definition["description"],
            "only_skill_tool_exposed_to_model": True,
            "provider_returned_real_skill_tool_call": True,
            "tool_execute_before_observed": True,
            "native_canonical_tool_visible_before_adapter": True,
            "adapter_execute_observed": True,
            "tool_execute_after_observed": True,
            "tool_before_after_call_ids_match": True,
            "adapter_context_messageID_matches_canonical_assistant_message": True,
            "adapter_context_callID_matches_canonical_tool_part": True,
            "canonical_assistant_parent_matches_submitted_user_message": True,
            "canonical_session_directory_and_plugin_worktree_match": True,
            "before_after_canonical_identity_and_state_consistent": True,
            "native_http_prompt_contains_completed_tool_result": True,
            "tool_output_exactly_matches_captured_skill_bytes": True,
            "runtime_owned_output_reached_real_model_request": True,
            "unchecked_vendor_body_marker_in_forwarded_requests": False,
            "unchecked_vendor_description_marker_in_forwarded_requests": False,
            "final_reply_contains_runtime_owned_phrase": True,
        }
        success = True

    except BaseException as error:
        summary["failure"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }

    finally:
        try:
            cleanup = cleanup_process(process, api_url, paths["api_evidence"])
        except BaseException as error:
            cleanup = {
                "started": process is not None,
                "pid": process.pid if process else None,
                "wait_completed": False,
                "process_alive_after_cleanup": process.poll() is None if process else None,
                "errors": [f"cleanup raised {type(error).__name__}: {error}"],
            }
        if proxy is not None:
            try:
                proxy.stop()
                proxy_port_unreachable = port_unreachable(proxy.base_url, "/__otter_health")
            except BaseException as error:
                summary.setdefault("cleanup_errors", []).append(f"recording proxy cleanup: {type(error).__name__}: {error}")
            proxy_requests = proxy.snapshot()
            forwarded_requests = [item for item in proxy_requests if item.get("forwarded") is True]
            blocked_requests = [item for item in proxy_requests if item.get("unchecked_markers_detected")]
            existing_proxy_summary = summary.get("ollama_proxy", {})
            summary["ollama_proxy"] = {
                **existing_proxy_summary,
                "listen_url": proxy.base_url,
                "upstream_url": args.ollama_base_url,
                "request_count": len(proxy_requests),
                "forwarded_request_count": len(forwarded_requests),
                "blocked_unchecked_marker_request_count": len(blocked_requests),
                "capability_refusal_count": sum(1 for item in proxy_requests if item.get("forwarding_block_reason")),
                "capability_refusals": [item["forwarding_block_reason"] for item in proxy_requests if item.get("forwarding_block_reason")],
                "blocked_marker_names": sorted(
                    {
                        marker
                        for item in blocked_requests
                        for marker in item.get("unchecked_markers_detected", [])
                    }
                ),
                "unchecked_markers_forwarded_to_ollama": any(
                    item.get("forwarded") is True and item.get("unchecked_markers_detected")
                    for item in proxy_requests
                ),
                "requests": proxy_requests,
                "model_tool_calls": [
                    call
                    for item in proxy_requests
                    for call in item.get("upstream_observations", {}).get("tool_calls", [])
                ],
                "real_upstream_response_count": sum(1 for item in forwarded_requests if item.get("http_status") == 200),
                "synthetic_model_responses": False,
            }
        if paths["tool_evidence"].is_file():
            tool_events = [
                json.loads(line)
                for line in paths["tool_evidence"].read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        else:
            tool_events = []
        existing_tool_summary = summary.get("native_tool_evidence", {})
        summary["native_tool_evidence"] = {
            **existing_tool_summary,
            "events": tool_events,
            "before_count": sum(1 for event in tool_events if event.get("phase") == "tool.execute.before"),
            "adapter_execute_count": sum(1 for event in tool_events if event.get("phase") == "adapter.execute"),
            "after_count": sum(1 for event in tool_events if event.get("phase") == "tool.execute.after"),
        }
        system_events = [
            event for event in tool_events if event.get("phase") == "experimental.chat.system.transform"
        ]
        system_events.sort(key=lambda event: event.get("sequence", 0))
        if owned_system_hash is not None:
            existing_system_summary = summary.get("system_channel_ownership", {})
            summary["system_channel_ownership"] = {
                **existing_system_summary,
                "hook": "experimental.chat.system.transform",
                "replacement_mode": "wholesale-fixed-system-array-replacement",
                "ordering_source": "OpenCode v1.18.35 packages/opencode/src/session/llm/request.ts: merged system is passed to the hook before model parameters and inference",
                "trusted_system_fixture": OWNED_SYSTEM_PROMPT,
                "trusted_system_sha256": owned_system_hash,
                "native_transform_events": system_events,
                "before_system_hashes": [event.get("beforeSha256") for event in system_events],
                "after_system_hashes": [event.get("afterSha256") for event in system_events],
                "unchecked_description_marker_observed_before_override": any(
                    event.get("uncheckedDescriptionMarkerBefore") is True for event in system_events
                ),
                "unchecked_body_marker_observed_before_override": any(
                    event.get("uncheckedBodyMarkerBefore") is True for event in system_events
                ),
                "unchecked_markers_observed_after_override": any(
                    event.get("uncheckedBodyMarkerAfter") is True or event.get("uncheckedDescriptionMarkerAfter") is True
                    for event in system_events
                ),
                "inference_request_system_hashes": [item.get("system_messages_sha256") for item in proxy_requests] if proxy else [],
                "inference_request_system_prompts_are_exact_fixture": bool(proxy_requests)
                and all(
                    item.get("system_messages_sha256") == owned_system_hash
                    and item.get("system_message_count") == 1
                    for item in proxy_requests
                ),
                "scope": "native OpenCode API capability evidence only; not authority for production prompt changes or product authorization",
            }
        summary["cleanup"] = cleanup
        summary["cleanup"]["proxy_port_unreachable_after_cleanup"] = proxy_port_unreachable
        summary["finished_at"] = utc_now()
        marker_blocked = summary.get("ollama_proxy", {}).get("blocked_unchecked_marker_request_count", 0) > 0
        refusal_reasons = summary.get("ollama_proxy", {}).get("capability_refusals", [])
        refusals = summary.get("ollama_proxy", {}).get("capability_refusal_count", 0)
        system_refused = any("fixed runtime-owned system prompt" in reason for reason in refusal_reasons)
        summary["capability_outcome"] = (
            "native-plugin-skill-override-and-system-channel-control-observed"
            if success
            else "refused-unchecked-project-skill-text-before-ollama"
            if marker_blocked
            else "native-system-channel-control-not-proven"
            if system_refused
            else "native-skill-adapter-capability-not-proven"
            if refusals
            else "not-run-or-incomplete"
        )
        if marker_blocked:
            summary["capability_failure"] = "Unchecked project-skill text appeared in a native model request; the local proxy refused to forward it to Ollama."
        elif system_refused:
            summary["capability_failure"] = "The native system transform did not produce exactly the fixed trusted fixture; the proxy refused to forward the request to Ollama."
        elif refusals:
            summary["capability_failure"] = "The native request did not satisfy the registered safe skill-tool contract, so the proxy refused inference."
        summary["success"] = bool(
            success
            and cleanup is not None
            and cleanup.get("wait_completed") is True
            and cleanup.get("process_alive_after_cleanup") is False
            and cleanup.get("server_port_unreachable_after_cleanup") is True
            and proxy_port_unreachable is True
            and not cleanup.get("errors")
            and not summary.get("cleanup_errors")
        )
        line = f"Native skill contract probe {'PASSED' if summary['success'] else 'FAILED'}; summary: {paths['summary']}\n"
        error_text = line
        if not summary["success"] and summary.get("failure"):
            error_text += f"{summary['failure']['type']}: {summary['failure']['message']}\n"
        status_line(paths["harness_stdout"], line if summary["success"] else "")
        status_line(paths["harness_stderr"], "" if summary["success"] else error_text)
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
