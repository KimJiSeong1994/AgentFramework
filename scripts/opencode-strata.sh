#!/usr/bin/env bash
# OpenCode + an already-running loopback Strata server.
#
#   scripts/opencode-strata.sh            # OpenCode TUI
#   scripts/opencode-strata.sh run "..."  # pass arguments through to OpenCode
set -euo pipefail

BASE_URL="${STRATA_BASE_URL:-http://127.0.0.1:18080/v1}"
CONTEXT="${STRATA_CONTEXT:-32768}"
OUTPUT="${STRATA_OUTPUT:-8192}"

command -v opencode >/dev/null 2>&1 || { echo 'opencode CLI가 필요합니다.' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl이 필요합니다.' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'python3이 필요합니다.' >&2; exit 1; }

if [[ ! "$BASE_URL" =~ ^http://127\.0\.0\.1:([0-9]{1,5})/v1$ ]]; then
  echo 'STRATA_BASE_URL은 loopback HTTP URL이어야 합니다 (예: http://127.0.0.1:18080/v1).' >&2
  exit 1
fi
PORT="${BASH_REMATCH[1]}"
if (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  echo 'STRATA_BASE_URL의 포트는 1–65535 범위여야 합니다.' >&2
  exit 1
fi
if [[ ! "$CONTEXT" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo 'STRATA_CONTEXT는 1–999999999 범위의 양의 정수여야 합니다.' >&2
  exit 1
fi
if [[ ! "$OUTPUT" =~ ^[1-9][0-9]{0,8}$ ]] || (( OUTPUT >= CONTEXT )); then
  echo 'STRATA_OUTPUT은 양의 정수이며 STRATA_CONTEXT보다 작아야 합니다.' >&2
  exit 1
fi

if ! STRATA_CONFIG="$(curl -fsS --connect-timeout 1 --max-time 4 --max-filesize 1048576 "${BASE_URL}/models" 2>/dev/null | python3 -c '
import json
import re
import sys

MAX_RESPONSE_BYTES = 1048576
base_url, context_text, output_text = sys.argv[1:]
body = sys.stdin.buffer.read(MAX_RESPONSE_BYTES + 1)
if len(body) > MAX_RESPONSE_BYTES:
    print("Strata /v1/models response exceeds the 1 MiB limit.", file=sys.stderr)
    raise SystemExit(1)
try:
    response = json.loads(body)
except (json.JSONDecodeError, UnicodeDecodeError):
    print("Strata /v1/models returned invalid JSON.", file=sys.stderr)
    raise SystemExit(1)

models = response.get("data") if isinstance(response, dict) else None
if not isinstance(models, list) or not models:
    print("Strata /v1/models returned no models.", file=sys.stderr)
    raise SystemExit(1)

model_id = None
for item in models:
    if not isinstance(item, dict):
        print("Strata /v1/models contains a malformed model entry.", file=sys.stderr)
        raise SystemExit(1)
    candidate = item.get("id")
    if not isinstance(candidate, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", candidate):
        print("Strata /v1/models contains an empty, non-string, or malformed model ID.", file=sys.stderr)
        raise SystemExit(1)
    architecture = item.get("architecture")
    if not isinstance(architecture, dict):
        print("Strata /v1/models contains a model without valid architecture modalities.", file=sys.stderr)
        raise SystemExit(1)
    inputs = architecture.get("input_modalities")
    outputs = architecture.get("output_modalities")
    if (not isinstance(inputs, list) or not all(isinstance(modality, str) for modality in inputs)
            or not isinstance(outputs, list) or not all(isinstance(modality, str) for modality in outputs)):
        print("Strata /v1/models contains a model without valid architecture modalities.", file=sys.stderr)
        raise SystemExit(1)
    if model_id is None and "text" in inputs and "text" in outputs:
        model_id = candidate

if model_id is None:
    print("Strata /v1/models does not advertise a text-to-text model.", file=sys.stderr)
    raise SystemExit(1)

qualified_model = "strata/" + model_id
config = {
    "$schema": "https://opencode.ai/config.json",
    "plugin": [],
    "enabled_providers": ["strata"],
    "model": qualified_model,
    "small_model": qualified_model,
    "permission": {"task": "deny"},
    "provider": {
        "strata": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Strata (loopback)",
            "options": {"baseURL": base_url},
            "models": {
                model_id: {
                    "name": model_id,
                    "modalities": {"input": ["text"], "output": ["text"]},
                    "tool_call": True,
                    "limit": {"context": int(context_text), "output": int(output_text)},
                }
            },
        }
    },
}
print(model_id)
print(json.dumps(config, separators=(",", ":")))
' "$BASE_URL" "$CONTEXT" "$OUTPUT")"; then
  echo "Strata API preflight failed: GET ${BASE_URL}/models. Start Strata and check its loopback /v1 API; this launcher does not install, start, or stop it." >&2
  exit 1
fi
MODEL="${STRATA_CONFIG%%$'\n'*}"
OPENCODE_CONFIG_CONTENT="${STRATA_CONFIG#*$'\n'}"
if [[ -z "$OPENCODE_CONFIG_CONTENT" || "$MODEL" == "$STRATA_CONFIG" ]]; then
  echo 'Strata /v1/models did not produce a valid text model configuration.' >&2
  exit 1
fi
export OPENCODE_CONFIG_CONTENT

# --pure prevents OpenCode from loading external plugins (including global plugins).
# The inline config above replaces global main/small model selection for this run.
exec opencode --pure --model "strata/${MODEL}" "$@"
