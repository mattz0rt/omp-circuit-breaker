#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/index.ts"
DST="${HOME}/.omp/agent/extensions/error-circuit-breaker.ts"
mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
echo "Installed to $DST"
echo "Run: omp --extension \"$DST\"  or restart omp to auto-load"
echo "Config: OMP_ERROR_BREAKER_THRESHOLD=3 OMP_ERROR_BREAKER_STATUS_CODES=400-599 omp"
echo "Commands: /error-breaker status|reset|pause|resume|config <n>  (alias /circuit-breaker)"
