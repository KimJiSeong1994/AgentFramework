#!/usr/bin/env bash
set -euo pipefail

# Keep the user's global Codex model unchanged.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v codex >/dev/null || { echo 'codex CLI is required.' >&2; exit 1; }

exec codex \
  --cd "$ROOT" \
  --oss \
  --local-provider ollama \
  --model gemma4:31b \
  --sandbox workspace-write \
  --ask-for-approval on-request \
  "$@"
