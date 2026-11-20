"""Pure-function checks for scripts/mlx-server.py (no model is loaded)."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("mlx_server", Path(__file__).resolve().parents[1] / "scripts" / "mlx-server.py")
mlx_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mlx_server)


def test_checkpoints_sit_on_absolute_multiples_below_the_prompt_length():
    assert mlx_server.aligned_boundaries(256) == []
    assert mlx_server.aligned_boundaries(257) == [256]
    assert mlx_server.aligned_boundaries(2082) == [256, 512, 768, 1024, 1280, 1536, 1792, 2048]


def test_prefill_spans_are_cut_at_the_same_absolute_positions_with_or_without_a_saved_state():
    full = mlx_server.prefill_plan(0, 2082)
    resumed = mlx_server.prefill_plan(1792, 2082)
    assert full[0] == (0, 256) and full[-1] == (2048, 2081)
    assert resumed == [span for span in full if span[0] >= 1792]
    # The last prompt token is never prefilled: decoding starts from it, so both paths do identical work.
    assert mlx_server.prefill_plan(2081, 2082) == []
    assert all(end - begin <= 256 for begin, end in full)


def test_prefix_keys_depend_on_exactly_the_leading_tokens():
    tokens = list(range(600))
    assert mlx_server.prefix_key(tokens, 256) == mlx_server.prefix_key(tokens[:256] + [9] * 10, 256)
    assert mlx_server.prefix_key(tokens, 256) != mlx_server.prefix_key([1] + tokens[1:], 256)


def test_reasoning_is_split_from_the_answer_only_when_thinking_is_enabled():
    plain = mlx_server.ReasoningSplitter(False)
    assert plain.feed("<b>hi</b>") == ("", "<b>hi</b>")
    thinking = mlx_server.ReasoningSplitter(True)
    pieces = [thinking.feed(piece) for piece in ["<think>\nplan", " more</th", "ink>\n\n{\"type\"", ":\"final\"}"]]
    reasoning = "".join(r for r, _ in pieces) + thinking.flush()[0]
    answer = "".join(a for _, a in pieces)
    assert "plan more" in reasoning and "<think>" not in reasoning
    assert answer == "{\"type\":\"final\"}"
    unclosed = mlx_server.ReasoningSplitter(True)
    first = unclosed.feed("never closed")
    rest = unclosed.flush()
    assert first[0] + rest[0] == "never closed" and first[1] == rest[1] == ""


TOOLS = [{"type": "function", "function": {"name": "read", "parameters": {"type": "object", "properties": {
    "path": {"type": "string"}, "limit": {"type": "integer"}, "flags": {"type": "array"}}}}}]


def test_xml_tool_calls_become_openai_tool_calls_typed_by_the_schema():
    text = ("<tool_call>\n<function=read>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=limit>\n20\n</parameter>\n"
            "<parameter=flags>\n[\"x\"]\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=read>\n"
            "<parameter=path>\n007\n</parameter>\n</function>\n</tool_call>")
    calls = mlx_server.parse_tool_calls(text, TOOLS)
    assert [c["function"]["name"] for c in calls] == ["read", "read"]
    assert json.loads(calls[0]["function"]["arguments"]) == {"path": "src/a.ts", "limit": 20, "flags": ["x"]}
    assert json.loads(calls[1]["function"]["arguments"]) == {"path": "007"}  # a string parameter is never reparsed
    assert all(c["type"] == "function" and c["id"].startswith("call_") for c in calls)
    multiline = mlx_server.parse_tool_calls("<tool_call>\n<function=write>\n<parameter=body>\nline 1\n\nline 2\n</parameter>\n</function>\n</tool_call>", None)
    assert json.loads(multiline[0]["function"]["arguments"]) == {"body": "line 1\n\nline 2"}
    as_json = mlx_server.parse_tool_calls('<tool_call>\n{"name": "read", "arguments": {"path": "b"}}\n</tool_call>', TOOLS)
    assert json.loads(as_json[0]["function"]["arguments"]) == {"path": "b"}
    assert mlx_server.parse_tool_calls("<tool_call>\nnot a call\n</tool_call>", TOOLS) == []


def test_the_tool_stream_returns_plain_answers_byte_for_byte_and_splits_off_a_call():
    plain = "Here is <b>code</b>:\n\n  x < y  \n"
    for size in (1, 2, 3, 7):
        stream = mlx_server.ToolCallStream(True)
        emitted = "".join(stream.feed(plain[i:i + size]) for i in range(0, len(plain), size))
        rest, calls = stream.finish(TOOLS)
        assert emitted + rest == plain and calls == []
    stream = mlx_server.ToolCallStream(True)
    output = "I'll read it.\n\n<tool_call>\n<function=read>\n<parameter=path>\na\n</parameter>\n</function>\n</tool_call>"
    emitted = "".join(stream.feed(output[i:i + 3]) for i in range(0, len(output), 3))
    rest, calls = stream.finish(TOOLS)
    assert emitted == "I'll read it." and rest == "" and len(calls) == 1
    broken = mlx_server.ToolCallStream(True)
    assert broken.feed("<tool_call>\nnonsense") == ""
    assert broken.finish(TOOLS) == ("<tool_call>\nnonsense", [])
    off = mlx_server.ToolCallStream(False)
    assert off.feed("<tool_call>x") == "<tool_call>x" and off.finish(TOOLS) == ("", [])


def test_prior_tool_calls_are_normalized_for_the_chat_template():
    messages = [{"role": "user", "content": [{"type": "text", "text": "go"}]},
                {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read", "arguments": "{\"path\": \"a\"}"}}]},
                {"role": "tool", "tool_call_id": "c1", "content": "file text"}]
    out = mlx_server.normalize_messages(messages)
    assert out[0]["content"] == "go"
    assert out[1]["tool_calls"][0]["function"]["arguments"] == {"path": "a"}
    assert messages[1]["tool_calls"][0]["function"]["arguments"] == "{\"path\": \"a\"}"  # the request is not mutated
    assert mlx_server.normalize_messages([{"role": "assistant", "tool_calls": [{"function": {"name": "x", "arguments": "oops"}}]}])[0]["tool_calls"][0]["function"]["arguments"] == {"arguments": "oops"}
