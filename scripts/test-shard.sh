#!/usr/bin/env bash
# Runs one shard of the framework test suite: every Nth test file (sorted), so CI can split the ~20-minute suite.
# Usage: scripts/test-shard.sh <shard-index 1..N> <shard-count N>   (run from the repository root)
set -euo pipefail
index="${1:?shard index}"; count="${2:?shard count}"
cd "$(dirname "$0")/../framework"
files=$(find test -name '*.test.ts' | LC_ALL=C sort | awk -v i="$index" -v n="$count" 'NR % n == (i % n)')
if [ -z "$files" ]; then echo "shard $index/$count: no files"; exit 0; fi
echo "shard $index/$count: $(echo "$files" | wc -l | tr -d ' ') files"
# shellcheck disable=SC2086
exec bun test $files
