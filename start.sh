#!/usr/bin/env bash
# Start both the Qimen Python sidecar and the Node app.
# If either dies, kill the other and exit non-zero so Railway restarts us.
set -uo pipefail

cleanup() {
  echo "[start.sh] cleanup: terminating children"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Qimen sidecar (Python) — never abort the deploy if it can't start;
# the Node app must still come up so the cockpit is reachable.
echo "[start.sh] starting Qimen sidecar on port ${QIMEN_SIDECAR_PORT:-8765}"
if command -v python3.11 >/dev/null 2>&1; then
  PY=python3.11
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  echo "[start.sh] WARN: no python3 on PATH — skipping sidecar"
  PY=""
fi

if [ -n "$PY" ]; then
  echo "[start.sh] using $PY"
  $PY -u server/qimen/sidecar.py &
  SIDECAR_PID=$!
  sleep 2
fi

# 2. Node app (the must-have)
echo "[start.sh] starting Node app"
node dist/index.cjs &
NODE_PID=$!

# Wait for the Node app specifically — sidecar dying should NOT kill the app.
wait "$NODE_PID"
EXIT_CODE=$?
echo "[start.sh] node app exited with code=$EXIT_CODE"
exit "$EXIT_CODE"
