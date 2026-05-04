#!/bin/bash
# Standalone start script for the Qimen sidecar Railway service.
# This service runs ONLY the FastAPI Python app — no Node, no screener.
set -e

echo "[sidecar-start.sh] RUNNING at $(date)"

# Detect whichever Python is on PATH
if command -v python3.11 >/dev/null 2>&1; then
  PY=python3.11
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "[sidecar-start.sh] FATAL: no python on PATH" >&2
  exit 127
fi
echo "[sidecar-start.sh] using $PY ($($PY --version 2>&1))"

# Verify dependencies before launching uvicorn
$PY -c "import kinqimen; print('kinqimen', getattr(kinqimen, '__version__', 'unknown'))" \
  || echo "[sidecar-start.sh] WARN: kinqimen import failed (sidecar will report degraded)"
$PY -c "import fastapi, uvicorn; print('fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)" \
  || { echo "[sidecar-start.sh] FATAL: fastapi/uvicorn missing" >&2; exit 1; }

echo "[sidecar-start.sh] launching uvicorn on PORT=${PORT:-8765}"
exec $PY -u qimen_deploy.py
