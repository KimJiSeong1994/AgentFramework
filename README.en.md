# AgentFramework (`otter`)

[한국어](README.md) · [English](README.en.md)

![otter: a coding agent that builds knowledge with every run](artifacts/otter-hero/hero.png)

**A coding agent that builds knowledge with every run.**

- Keeps execution history as local knowledge and reuses it in future tasks
- Builds a shared knowledge base across engines and models, with different models for different roles
- Edits files and runs commands directly in conversation. Every execution requires human approval, either per action or per plan

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh | bash otter
```

```powershell
# Windows (PowerShell, using WSL2)
irm https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.ps1 | iex otter
```

## 1. Execution history becomes a reusable asset

**Conversations may end, but their history stays and becomes context for the next task.**

- **Record**: Automatically saves metadata about tool results and command exit codes from every engine
- **Summarize**: Provides a digest for each session (`/history`); recurring command successes and failures, along with frequently changed files, become reference material for future conversations (`/facts`)
- **Build and reuse knowledge**: Projects with a wiki automatically capture knowledge in `knowledge/` when a session ends; the `memory` tool retrieves it during conversations
- **Resume**: Each launch starts a new conversation; use `--resume` or `/sessions` when you want to pick up a previous one

## 2. Any engine, multiple models

**One shared history across engines, with the right model for each role.**

- **Engines**: Ollama, Codex, and Claude CLI; switch during a conversation with `/model`
- **Combos**: Assign models to planning, execution, architecture, and review roles. Regular conversations use the main model; combos apply to workflow roles, with the active model shown on screen
- **Presets**: Four Codex × Claude combinations (such as `astra-fable`); select one in `/model combo` to apply it immediately
- **Sign-in**: Use each CLI's official sign-in flow (`/login`). If authentication is not recognized, run `otter auth --diagnose`

## 3. Automatic skills and intent routing

**Offers help proactively while keeping you in control.**

- **Automatic skills**: Loads skills suited to the context and displays `Skills used:`
- **Intent routing**: Suggests deep-interview or ralplan for ambiguous or large requests, without starting them automatically
- **Disable**: Use the `force:` prefix or `/skills auto off`; see [`skill_index.md`](skill_index.md) for the skill list

## Direct execution and safeguards

**Every execution requires human approval, either per action or per plan.**

- **Execute in conversation**: Approve each edit or command after viewing its diff or command line; use `/undo` to revert changes
- **Fewer approval prompts**: Read-only commands need no approval, and edits across multiple files can be approved together
- **Always rejected**: Commands such as `sudo` and force pushes; use `!command` to run a command yourself
- **Plan-level approval**: `/plan` → `/approve` → execution in a separate worktree

## Documentation

[Usage and configuration](framework/README.md) · [Skill list](skill_index.md) · [Wiki schema](knowledge/AGENTS.md) · [Design](docs/agent-framework-review-2026-09-22.md) · [MIT license](LICENSE)
