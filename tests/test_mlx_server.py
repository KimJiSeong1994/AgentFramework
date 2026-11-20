"""Pure-function checks for scripts/mlx-server.py (no model is loaded)."""
import importlib.util
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
