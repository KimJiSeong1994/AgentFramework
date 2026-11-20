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
Binds 127.0.0.1 only. One request at a time (single-user; requests queue on a lock).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
import threading
import time
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
                messages = request["messages"]
                for message in messages:
                    if isinstance(message.get("content"), list):
                        message["content"] = "".join(part.get("text", "") for part in message["content"] if isinstance(part, dict))
                kwargs = request.get("chat_template_kwargs") or {}
                thinking = bool(kwargs.get("enable_thinking", False))
                tokens = list(engine.tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=thinking))
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
                think, text = think + more_think, text + more_text
                if think:
                    reasoning.append(think)
                    if stream: chunk({"reasoning_content": think})
                if text:
                    answer.append(text)
                    if stream: chunk({"content": text})
                usage = {"prompt_tokens": len(tokens), "completion_tokens": produced, "total_tokens": len(tokens) + produced,
                         "prompt_tokens_details": {"cached_tokens": cached}}
                if log_path and stream:
                    with open(log_path, "a") as handle:
                        handle.write(json.dumps({"request": request, "answer": "".join(answer), "cached": cached}, ensure_ascii=False) + "\n")
                if stream:
                    chunk({}, finish)
                    if include_usage:
                        chunk({}, usage=usage)
                    try:
                        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                if log_path:  # verification only: the exact request and answer, for replay against --no-prefix-cache
                    with open(log_path, "a") as handle:
                        handle.write(json.dumps({"request": request, "answer": "".join(answer), "cached": cached}, ensure_ascii=False) + "\n")
                message = {"role": "assistant", "content": "".join(answer)}
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
