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
python3.11 server/qimen/sidecar.py &
SIDECAR_PID=$!

# Give the sidecar a moment to bind its port
sleep 2

# 2. Node app
echo "[start.sh] starting Node app"
node dist/index.cjs &
NODE_PID=$!

# Wait for either process to exit
wait -n "$SIDECAR_PID" "$NODE_PID"
EXIT_CODE=$?
echo "[start.sh] one process exited with code=$EXIT_CODE"
exit "$EXIT_CODE"
