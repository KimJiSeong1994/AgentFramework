---
name: ulw
description: Ultrawork - split a big request into verifiable tasks, hand the whole list to the delegate tool once, report the result
compatibility: opencode
---

# ulw (ultrawork) procedure

Triggered by `ultrawork`, `ulw`, `울트라워크`, `끝까지 해`, `멈추지 말고`. The short form is appended to each
user message as `<otter-mode name="ulw">`; this file is the long form. Read it once, then act.

You do not do the work yourself. The framework runs each task in its own worker session, runs the task's
verify command, has a reviewer judge the diff, and gives you one report back.

## Steps

1. Look only as much as needed to split the request: `glob`/`grep` to find the files, `read` the tests that
   must pass. Do not edit anything.
2. Write the task list (3-12 tasks). Each task:
   - `title`: one line, what it delivers.
   - `detail`: what to change and in which files. Name every file the task may touch; the reviewer rejects
     changes to files a task does not name.
   - `verify`: a test/check command that passes when THIS task alone is done, e.g.
     `python3 -m pytest -q test_circle.py`, `bun test src/x.test.ts`, `go test ./pkg/...`.
     Never the whole suite (earlier tasks would fail on later tasks' tests), never `true`/`echo`/`ls`.
     Only test/check runners are accepted; shell pipes and `;` are refused.
   - Tasks run in the given order; put shared groundwork (a base module, a fixture) first.
3. Call the `delegate` tool once with the whole list. Do not call it again for the same request.
4. When it returns, report in at most 10 lines: one line per task (`done`/`failed` + verify), files
   changed, and what is left. Do not redo failed tasks yourself unless the user asks.

## Interruptions

- `/stop` cancels the queue; the report names the cancelled tasks.
- If the framework tells you tasks from an interrupted run are unfinished, call `delegate` with
  `resume: true` (no task list) to run them.
