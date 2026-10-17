# fib fixture (otter stage-1 acceptance)

`fib.py` is intentionally absent. Prompt used by `scripts/otter-e2e.sh`:

> Implement fib(n) in fib.py so that test_fib.py passes. Run the tests.

Pass condition: `python3 -m pytest -q` (or `python3 test_fib.py`) succeeds, and
`test_fib_is_iterative` rejects recursive implementations via a low recursion limit.
