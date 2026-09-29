"""Stage-1 acceptance fixture for lca. `fib.py` is missing on purpose; the agent must create it.

Run with `python3 -m pytest -q` or plain `python3 test_fib.py`.
"""
import sys

EXPECTED = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55]


def _stack_depth():
    depth, frame = 0, sys._getframe()
    while frame is not None:
        depth += 1
        frame = frame.f_back
    return depth


def test_fib_0_to_10():
    from fib import fib

    assert [fib(n) for n in range(11)] == EXPECTED


def test_fib_is_iterative():
    """A recursive implementation (memoised or not) needs ~200 frames here; an iterative one needs none."""
    from fib import fib

    old = sys.getrecursionlimit()
    sys.setrecursionlimit(_stack_depth() + 40)
    try:
        assert fib(200) == 280571172992510140037611932413038677189525
    finally:
        sys.setrecursionlimit(old)


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    sys.exit(1 if failures else 0)
