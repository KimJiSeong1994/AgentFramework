# ulw-fail fixture (stage-2 negative case)

Three modules like `ulw3`, but `test_rect.py` contains `assert 1 == 2` (independent of the code: a code-dependent
impossible assertion was gamed by a stateful `rect_area` in an earlier run and the reviewer accepted it). Prompt used by
`scripts/otter-e2e.sh --fixture ulw-fail`:

> ulw: Implement circle.py, rect.py and triangle.py so that test_circle.py, test_rect.py and test_triangle.py pass.
> One module per task; verify each with `python3 -m pytest -q <its test file>`.

Expected: ledger `[done, failed, done]`, the failed task has 2 attempts and `review.verdict == skipped`,
the queue did not stop at the failure, main's final report mentions the failure. The e2e exits 0 when this holds.
