# plan3 fixture (lca M1 plan-workflow acceptance)

`stack.py`, `queue_.py` and `lru_cache.py` are intentionally absent. This fixture is used with
`scripts/lca-e2e.sh --flow plan --fixture plan3` (or `--entry keyword`): the request describes three
small, independent data-structure features; a correct plan has exactly one step per feature, each
step naming its own file and its own verify command.

Request used by the driver:

> Implement three independent data structures: a Stack class in stack.py (push, pop, peek,
> is_empty), a Queue class in queue_.py (enqueue, dequeue FIFO order, is_empty, dequeue raises
> IndexError when empty), and an LRUCache(capacity) class in lru_cache.py (get, put, evicts the
> least-recently-used key when capacity is exceeded). Plan one step per class; verify each with
> `python3 -m pytest -q <its test file>`.

Pass condition (F01-F05, AC1.1-AC1.2): the submitted plan validates and its rendered markdown
exists; the event sequence goes `created` .. `plan_submitted` .. `approved` .. `tasks_created` ..
`done` (an `owner_takeover` event between two driver processes is allowed); no `edit`/`write` tool
call happens while the workflow is still `planning`; the ledger ends up with exactly 3 tasks tagged
to the approved plan, their titles identical to the plan's step titles, all `done`; and
`python3 -m pytest -q` passes across all three test files.
