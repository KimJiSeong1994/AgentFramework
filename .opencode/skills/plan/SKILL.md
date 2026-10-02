---
name: plan
description: Plan mode - read-only investigation that yields a numbered, verifiable implementation plan
compatibility: opencode
---

# plan procedure

Triggered by `plan mode`, `ralplan`, `hyperplan`, `계획부터`, `계획 모드`. The short form is appended
to each user message as `<lca-mode name="plan">`; this file is the long form.

## Rules

- Read-only: use `read`, `glob`, `grep`, and read-only `bash` (ls, git log/diff, cat). Never
  `edit`, `write`, or run commands that change files, install packages, or start servers.
- Budget the investigation: at most ~10 file reads; `grep` to locate, `read` to confirm.
- Ask at most 2 clarifying questions, and only when a step cannot be written without the answer.
  Otherwise state the assumption inside the step and continue.

## Output format

```
Goal: <one sentence, what "done" means>

Steps:
1. <title> - files: <path[, path]> - verify: <test/check command for this step alone>
2. ...

Risks:
- <what could break, how to notice it>

Assumptions / questions (optional, max 2):
- ...
```

- 3-10 steps. Each step must name its files and a verification a worker can run without judgment.
- Order steps so each one leaves the repo in a working state (tests green or unchanged).
- Do not include code blocks longer than 5 lines; describe the change instead.

## Handoff

Submit the plan with `lca_flow op:"plan"` (do not just print it in a message). The user approves it with
`/approve`; each step becomes one `delegate` task (title / detail = the files and change / verify = the step's
command), so keep steps independent and their verify commands step-local.
