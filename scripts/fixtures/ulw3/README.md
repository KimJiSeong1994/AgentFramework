# ulw3 fixture (otter stage-2 acceptance: 3-task delegation)

`circle.py`, `rect.py` and `triangle.py` are intentionally absent. Prompt used by `scripts/otter-e2e.sh --fixture ulw3`:

> ulw: Implement circle.py, rect.py and triangle.py so that test_circle.py, test_rect.py and test_triangle.py pass.
> One module per task; verify each with `python3 -m pytest -q <its test file>`.

Pass condition (E01/E05-E08): `python3 -m pytest -q` succeeds, the main session's ledger has 3 tasks all `done`,
each task ran in its own worker child session, and the main session's cache misses stay <= tasks + 1.
