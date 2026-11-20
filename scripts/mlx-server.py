#!/usr/bin/env python3
"""OpenAI-compatible local server on MLX with exact prefix-state reuse (otter `local_model.server: "mlx"`).

Why: Qwen3.8-27B is a hybrid model (linear-attention layers keep a recurrent state that cannot be rewound), so a server
can only reuse work for a prompt whose leading tokens match a *saved state*. otter resends ~1.7k identical leading
tokens (role and tool instructions) on every call; this server saves the model state at fixed absolute positions
(every CHUNK tokens) and resumes from the longest saved one, so only the new tail is prefilled.

Answers never depend on the cache: prefill always runs in chunks aligned to absolute positions (0, 256, 512, ...),
so a request computed from a saved state performs exactly the same operations as one computed from scratch, and
decoding is greedy (argmax). `--no-prefix-cache` serves the same answers without reuse (for verification).

Endpoints: GET /v1/models, POST /v1/chat/completions (stream or not; usage with prompt_tokens_details.cached_tokens;
reasoning before </think> goes to reasoning_content when chat_template_kwargs.enable_thinking is true).

Tool calling (OpenAI `tools`): the tools are rendered by the model's own chat template, and the model's
`<tool_call><function=NAME><parameter=P>VALUE</parameter></function></tool_call>` output (or a JSON body inside
<tool_call>) is returned as `tool_calls` with finish_reason "tool_calls". Parameter values are typed by the tool's JSON
schema. Earlier assistant `tool_calls` (arguments as a JSON string) and `tool` results are fed back through the
template. `tool_choice: "none"` hides the tools; "required" or a named function is not enforced (no constrained
decoding). Text without a tool call is returned unchanged, so tools never alter a plain answer.
Binds 127.0.0.1 only. One request at a time (single-user; requests queue on a lock).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import threading
import time
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHUNK = 256


def aligned_boundaries(length: int, chunk: int = CHUNK) -> list[int]:
    """Absolute positions where a state is saved: multiples of chunk below length (the last token is never prefilled
    into a checkpoint because decoding starts from it)."""
    return list(range(chunk, length, chunk))


def prefill_plan(start: int, length: int, chunk: int = CHUNK) -> list[tuple[int, int]]:
    """(begin, end) prefill spans from start to length-1, cut at absolute multiples of chunk."""
    spans, pos, last = [], start, length - 1
    while pos < last:
        end = min((pos // chunk + 1) * chunk, last)
        spans.append((pos, end))
        pos = end
    return spans


def prefix_key(tokens: list[int], length: int) -> str:
    return hashlib.sha1(json.dumps(tokens[:length]).encode()).hexdigest()


class ReasoningSplitter:
    """With thinking enabled the model writes reasoning, then </think>, then the answer: route the two apart."""

    def __init__(self, thinking: bool):
        self.thinking, self.buffer, self.opened = thinking, "", False

    def feed(self, text: str) -> tuple[str, str]:
        if not self.thinking:
            return "", text
        self.buffer += text
        if not self.opened:
            # Hold a possibly split leading "<think>" until it is complete or ruled out, then drop it.
            lead = self.buffer.lstrip()
            if "<think>".startswith(lead):
                return "", ""
            if lead.startswith("<think>"):
                self.buffer = lead[len("<think>"):]
            self.opened = True
        marker = self.buffer.find("</think>")
        if marker < 0:
            keep = len("</think>") - 1  # a marker may be split across pieces
            reasoning, self.buffer = self.buffer[:-keep] if len(self.buffer) > keep else "", self.buffer[-keep:] if len(self.buffer) > keep else self.buffer
            return reasoning.replace("<think>", ""), ""
        reasoning, answer = self.buffer[:marker], self.buffer[marker + len("</think>"):]
        self.thinking, self.buffer = False, ""
        return reasoning.replace("<think>", ""), answer.lstrip("\n")

    def flush(self) -> tuple[str, str]:
        rest, self.buffer = self.buffer, ""
        return (rest.replace("<think>", ""), "") if self.thinking else ("", rest)


TOOL_OPEN, TOOL_CLOSE = "<tool_call>", "</tool_call>"


def normalize_messages(messages: list[dict]) -> list[dict]:
    """OpenAI chat messages in the shape the chat template expects: text parts joined, tool-call arguments as dicts."""
    out = []
    for message in messages:
        message = dict(message)
        if isinstance(message.get("content"), list):
            message["content"] = "".join(part.get("text", "") for part in message["content"] if isinstance(part, dict))
        if message.get("tool_calls"):
            calls = []
            for call in message["tool_calls"]:
                function = dict(call.get("function") or call)
                arguments = function.get("arguments")
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments) if arguments.strip() else {}
                    except ValueError:
                        arguments = {"arguments": arguments}
                function["arguments"] = arguments if isinstance(arguments, dict) else {"arguments": arguments}
                calls.append({**call, "function": function})
            message["tool_calls"] = calls
        out.append(message)
    return out


def _parameter_types(tools: list[dict] | None, name: str) -> dict:
    for tool in tools or []:
        function = tool.get("function") or tool
        if function.get("name") == name:
            return ((function.get("parameters") or {}).get("properties")) or {}
    return {}


def _typed_value(raw: str, schema: dict | None):
    """A parameter's text as its schema type: strings stay verbatim, other types are parsed as JSON when they parse."""
    kinds = (schema or {}).get("type")
    kinds = set(kinds) if isinstance(kinds, list) else {kinds}
    if not schema or "string" in kinds or kinds == {None}:
        return raw
    try:
        return json.loads(raw)
    except ValueError:
        lowered = raw.strip().lower()
        return {"true": True, "false": False, "null": None}.get(lowered, raw)


def parse_tool_calls(text: str, tools: list[dict] | None) -> list[dict]:
    """Tool calls in the model's output, as OpenAI tool_calls entries (arguments as a JSON string)."""
    calls = []
    for block in re.findall(r"<tool_call>(.*?)(?:</tool_call>|$)", text, re.S):
        body = block.strip()
        name, arguments = None, None
        function = re.search(r"<function=([^>\n]+)>(.*?)(?:</function>|$)", body, re.S)
        if function:
            name = function.group(1).strip()
            types = _parameter_types(tools, name)
            arguments = {}
            for match in re.finditer(r"<parameter=([^>\n]+)>(.*?)(?:</parameter>|(?=<parameter=)|$)", function.group(2), re.S):
                key, raw = match.group(1).strip(), match.group(2)
                raw = raw[1:] if raw.startswith("\n") else raw
                raw = raw[:-1] if raw.endswith("\n") else raw
                arguments[key] = _typed_value(raw, types.get(key))
        elif body.startswith("{"):
            try:
                parsed = json.loads(body)
                name, arguments = parsed.get("name"), parsed.get("arguments", parsed.get("parameters", {}))
            except (ValueError, AttributeError):
                pass
        if name:
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except ValueError:
                    arguments = {"arguments": arguments}
            if not isinstance(arguments, dict):
                arguments = {"arguments": arguments}
            calls.append({"id": f"call_{uuid.uuid4().hex[:24]}", "type": "function",
                          "function": {"name": name, "arguments": json.dumps(arguments or {}, ensure_ascii=False)}})
    return calls


class ToolCallStream:
    """Passes answer text through until a <tool_call> starts, then collects the rest for parse_tool_calls. Holds back a
    possibly split "<tool_call>" and trailing whitespace, so whitespace before a call is dropped and a plain answer is
    returned byte for byte."""

    def __init__(self, enabled: bool):
        self.enabled, self.pending, self.calls_text = enabled, "", None

    def feed(self, text: str) -> str:
        if not self.enabled:
            return text
        if self.calls_text is not None:
            self.calls_text += text
            return ""
        self.pending += text
        start = self.pending.find(TOOL_OPEN)
        if start >= 0:
            emit, self.calls_text, self.pending = self.pending[:start].rstrip(), self.pending[start:], ""
            return emit
        hold = next((n for n in range(min(len(TOOL_OPEN) - 1, len(self.pending)), 0, -1)
                     if TOOL_OPEN.startswith(self.pending[-n:])), 0)
        cut = len(self.pending[:len(self.pending) - hold].rstrip())
        emit, self.pending = self.pending[:cut], self.pending[cut:]
        return emit

    def finish(self, tools: list[dict] | None) -> tuple[str, list[dict]]:
        """(remaining answer text, tool calls). A malformed call is returned as text, never dropped."""
        if self.calls_text is None:
            rest, self.pending = self.pending, ""
            return rest, []
        calls = parse_tool_calls(self.calls_text, tools)
        return ("", calls) if calls else (self.calls_text, [])


class Engine:
    def __init__(self, model_path: str, served_name: str, cache_bytes: int, prefix_cache: bool):
        import mlx.core as mx
        from mlx_lm import load
        from mlx_lm.models.cache import make_prompt_cache

        self.mx, self.make_prompt_cache = mx, make_prompt_cache
        self.model, self.tokenizer = load(model_path)
        self.served_name, self.prefix_cache, self.cache_bytes = served_name, prefix_cache, cache_bytes
        self.checkpoints: OrderedDict[str, tuple[int, object, int]] = OrderedDict()  # key -> (position, cache, bytes)
        self.stored_bytes = 0
        self.lock = threading.Lock()

    def _nbytes(self, cache) -> int:
        total = 0
        for layer in cache:
            for array in (layer.state if isinstance(layer.state, (list, tuple)) else [layer.state]):
                total += getattr(array, "nbytes", 0) if array is not None else 0
        return total

    def _save(self, tokens: list[int], position: int, cache) -> None:
        key = prefix_key(tokens, position)
        if key in self.checkpoints:
            self.checkpoints.move_to_end(key)
            return
        snapshot = copy.deepcopy(cache)
        size = self._nbytes(snapshot)
        self.checkpoints[key] = (position, snapshot, size)
        self.stored_bytes += size
        while self.stored_bytes > self.cache_bytes and len(self.checkpoints) > 1:
            _, (_, _, freed) = self.checkpoints.popitem(last=False)
            self.stored_bytes -= freed

    def _restore(self, tokens: list[int]):
        """The longest saved state whose tokens are a prefix of this prompt, or a fresh cache at position 0."""
        if self.prefix_cache:
            for position in reversed(aligned_boundaries(len(tokens))):
                hit = self.checkpoints.get(prefix_key(tokens, position))
                if hit:
                    self.checkpoints.move_to_end(prefix_key(tokens, position))
                    return position, copy.deepcopy(hit[1])
        return 0, self.make_prompt_cache(self.model)

    def generate(self, tokens: list[int], max_tokens: int, should_stop):
        """Yields (token_id) greedily; first yields ("cached", n). Prefill runs on absolute-position-aligned chunks."""
        mx = self.mx
        start, cache = self._restore(tokens)
        yield ("cached", start)
        for begin, end in prefill_plan(start, len(tokens)):
            if should_stop():
                return
            self.model(mx.array(tokens[begin:end])[None], cache=cache)
            mx.eval([layer.state for layer in cache])
            if self.prefix_cache and end % CHUNK == 0:
                self._save(tokens, end, cache)
        current = mx.array(tokens[-1:])
        eos = set(self.tokenizer.eos_token_ids)
        for _ in range(max_tokens):
            if should_stop():
                return
            logits = self.model(current[None], cache=cache)[:, -1, :]
            token = int(mx.argmax(logits, axis=-1).item())
            if token in eos:
                return
            yield token
            current = mx.array([token])


def make_handler(engine: Engine, default_max_tokens: int, log_path: str | None = None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, fmt, *args):  # quiet access log; errors go to stderr
            pass

        def _json(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.rstrip("/") == "/v1/models":
                return self._json(200, {"object": "list", "data": [{"id": engine.served_name, "object": "model", "owned_by": "mlx", "created": int(time.time())}]})
            if self.path.rstrip("/") == "/health":
                return self._json(200, {"ok": True, "checkpoints": len(engine.checkpoints), "checkpoint_bytes": engine.stored_bytes})
            self._json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/chat/completions":
                return self._json(404, {"error": {"message": "not found"}})
            try:
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length) or b"{}")
                messages = normalize_messages(request["messages"])
                tools = request.get("tools") or None
                if tools is not None and (not isinstance(tools, list) or request.get("tool_choice") == "none"):
                    tools = None
                kwargs = request.get("chat_template_kwargs") or {}
                thinking = bool(kwargs.get("enable_thinking", False))
                tokens = list(engine.tokenizer.apply_chat_template(messages, tools=tools, add_generation_prompt=True, enable_thinking=thinking))
                max_tokens = int(request.get("max_tokens") or default_max_tokens)
            except Exception as error:  # malformed request
                return self._json(400, {"error": {"message": f"invalid request: {type(error).__name__}"}})
            stream = bool(request.get("stream"))
            include_usage = bool((request.get("stream_options") or {}).get("include_usage"))
            created, rid = int(time.time()), f"chatcmpl-{time.time_ns()}"
            disconnected = {"value": False}

            def chunk(delta: dict, finish: str | None = None, usage: dict | None = None) -> None:
                body = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": engine.served_name,
                        "choices": [] if usage is not None else [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage is not None:
                    body["usage"] = usage
                try:
                    self.wfile.write(f"data: {json.dumps(body)}\n\n".encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    disconnected["value"] = True

            with engine.lock:
                detok = engine.tokenizer.detokenizer
                detok.reset()
                splitter = ReasoningSplitter(thinking)
                tool_stream = ToolCallStream(tools is not None)
                answer, reasoning, produced, cached, finish = [], [], 0, 0, "stop"
                if stream:
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("cache-control", "no-cache")
                    self.end_headers()
                    chunk({"role": "assistant", "content": ""})
                for item in engine.generate(tokens, max_tokens, lambda: disconnected["value"]):
                    if isinstance(item, tuple):
                        cached = item[1]
                        continue
                    produced += 1
                    detok.add_token(item)
                    think, text = splitter.feed(detok.last_segment)
                    text = tool_stream.feed(text)
                    if think:
                        reasoning.append(think)
                        if stream: chunk({"reasoning_content": think})
                    if text:
                        answer.append(text)
                        if stream: chunk({"content": text})
                    if disconnected["value"]:
                        return
                if produced >= max_tokens:
                    finish = "length"
                detok.finalize()
                think, text = splitter.feed(detok.last_segment)
                more_think, more_text = splitter.flush()
                text = tool_stream.feed(text + more_text)
                tail, calls = tool_stream.finish(tools)
                think, text = think + more_think, text + tail
                if think:
                    reasoning.append(think)
                    if stream: chunk({"reasoning_content": think})
                if text:
                    answer.append(text)
                    if stream: chunk({"content": text})
                usage = {"prompt_tokens": len(tokens), "completion_tokens": produced, "total_tokens": len(tokens) + produced,
                         "prompt_tokens_details": {"cached_tokens": cached}}
                if calls:
                    finish = "tool_calls"
                    if stream:
                        for index, call in enumerate(calls):
                            chunk({"tool_calls": [{"index": index, **call}]})
                if log_path:  # verification only: the exact request and answer, for replay against --no-prefix-cache
                    with open(log_path, "a") as handle:
                        handle.write(json.dumps({"request": request, "answer": "".join(answer), "tool_calls": [c["function"] for c in calls],
                                                 "cached": cached}, ensure_ascii=False) + "\n")
                if stream:
                    chunk({}, finish)
                    if include_usage:
                        chunk({}, usage=usage)
                    try:
                        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                message = {"role": "assistant", "content": "".join(answer) or (None if calls else "")}
                if calls:
                    message["tool_calls"] = calls
                if reasoning:
                    message["reasoning_content"] = "".join(reasoning)
                self._json(200, {"id": rid, "object": "chat.completion", "created": created, "model": engine.served_name,
                                 "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="mlx-community/Qwen3.8-27B-4bit")
    parser.add_argument("--served-model-name", default="qwen3.8-27b")
    parser.add_argument("--port", type=int, default=30000)
    parser.add_argument("--prefix-cache-gb", type=float, default=8.0, help="memory budget for saved prefix states")
    parser.add_argument("--no-prefix-cache", action="store_true", help="never reuse saved states (same answers, slower)")
    parser.add_argument("--max-tokens", type=int, default=8192, help="default completion limit when a request sets none")
    parser.add_argument("--log-requests", help="append each request and answer to this JSONL file (verification only; contains prompts)")
    args = parser.parse_args()
    engine = Engine(args.model, args.served_model_name, int(args.prefix_cache_gb * 1e9), not args.no_prefix_cache)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(engine, args.max_tokens, args.log_requests))
    print(f"mlx-server ready on http://127.0.0.1:{args.port} (model {args.served_model_name}, prefix cache "
          f"{'off' if args.no_prefix_cache else f'{args.prefix_cache_gb:g} GB'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
