#!/usr/bin/env bash
# Start both the Qimen Python sidecar and the Node app.
# If either dies, kill the other and exit non-zero so Railway restarts us.
set -euo pipefail

cleanup() {
  echo "[start.sh] cleanup: terminating children"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Qimen sidecar (Python)
echo "[start.sh] starting Qimen sidecar on port ${QIMEN_SIDECAR_PORT:-8765}"
# Pick whichever Python is actually on PATH (Railway/nixpacks may install
# python3.11 or just python3). Fail loudly so logs explain non-boot.
if command -v python3.11 >/dev/null 2>&1; then
  PY=python3.11
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  echo "[start.sh] FATAL: no python3 on PATH" >&2
  exit 127
fi
echo "[start.sh] using $PY ($($PY --version 2>&1))"
$PY -u server/qimen/sidecar.py &
SIDECAR_PID=$!

# Give the sidecar a moment to bind its port; verify it actually came up.
sleep 3
if curl -fsS "http://127.0.0.1:${QIMEN_SIDECAR_PORT:-8765}/health" -m 2 >/dev/null 2>&1; then
  echo "[start.sh] sidecar healthy on :${QIMEN_SIDECAR_PORT:-8765}"
else
  echo "[start.sh] WARN: sidecar /health not responding yet (will continue; node will retry)"
fi

# 2. Node app
echo "[start.sh] starting Node app"
node dist/index.cjs &
NODE_PID=$!

# Wait for either process to exit
wait -n "$SIDECAR_PID" "$NODE_PID"
EXIT_CODE=$?
echo "[start.sh] one process exited with code=$EXIT_CODE"
exit "$EXIT_CODE"
