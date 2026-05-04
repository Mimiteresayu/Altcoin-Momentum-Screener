#!/usr/bin/env bash
# Main Railway service start script — Node app only.
# The Qimen Python sidecar runs as a SEPARATE Railway service (sidecar-start.sh)
# and is reached via QIMEN_URL env var.
set -uo pipefail

echo "[start.sh] starting Node app at $(date)"
echo "[start.sh] QIMEN_URL=${QIMEN_URL:-<unset>}"

# Optional: still run the embedded sidecar if explicitly enabled (legacy fallback).
# Default OFF — production deploys should use the dedicated sidecar service.
if [ "${EMBED_QIMEN_SIDECAR:-0}" = "1" ]; then
  echo "[start.sh] EMBED_QIMEN_SIDECAR=1 — also booting Python sidecar locally"
  if command -v python3.11 >/dev/null 2>&1; then PY=python3.11
  elif command -v python3   >/dev/null 2>&1; then PY=python3
  else PY=""; fi
  if [ -n "$PY" ]; then
    $PY -u qimen_deploy.py &
    SIDECAR_PID=$!
    sleep 2
  fi
fi

exec node dist/index.cjs
