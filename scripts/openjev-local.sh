#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OPENJEV_DIR="$ROOT/openjev"
PYTHON="$OPENJEV_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "OpenJev is not installed: expected executable virtualenv Python at $PYTHON" >&2
  exit 1
fi

export OPENJEV_BACKEND="${OPENJEV_BACKEND:-mlx}"
export OPENJEV_HOST="${OPENJEV_HOST:-127.0.0.1}"
export OPENJEV_PORT="${OPENJEV_PORT:-8080}"
export OPENJEV_MLX_MODEL="${OPENJEV_MLX_MODEL:-mlx-community/diffusiongemma-26B-A4B-it-4bit}"

cd -- "$OPENJEV_DIR"
exec "$PYTHON" -m openjev
