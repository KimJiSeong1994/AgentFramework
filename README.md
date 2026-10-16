# AgentFramework — Execute to Asset

> **Transform execution traces into structured, local knowledge.**

`lca` (Local Coding Agent) is a local-first framework designed to go beyond simple task execution. It treats every interaction—plans, tool outputs, and chat histories—as valuable assets that are automatically captured and organized into a queryable local knowledge base.

## Core Value
- **Assetization**: Automatically converts every execution trace (logs, sessions, tool results) into structured, permanent assets.
- **Knowledge Loop**: Transforms raw interaction history into organized Wikis, Entities, and Reports.
- **Rigorous Workflow**: A high-fidelity [Plan] $\to$ [Execute] $\to$ [Verify] cycle.
- **Engine Agnostic**: Connect any LLM (Ollama, Codex, Claude) to your local asset pipeline.

## Quick Start

```sh
curl -fsSL https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh | bash
```

## Usage

- `lca chat`: Start an interactive session and begin generating assets.
- `lca chat --engine <local|codex|claude>`: Select your engine.
- `/sessions`: View and resume your accumulated asset history.
- `/model <engine> <model>`: Switch models within a session.

## Documentation
- **LCA Guide**: `framework/README.md`
- **Architecture**: `docs/agent-framework-review-2026-09-22.md`
- **Setup**: `docs/ubuntu-setup.md`
