#!/usr/bin/env bash
set -e

# Default port for Google Cloud Run is 8080
export PORT="${PORT:-8080}"
export AI_SERVICE_URL="${AI_SERVICE_URL:-http://127.0.0.1:5005}"

echo "==========================================================="
echo "  Starting MyoMate Cloud Telemetry & AI Hub"
echo "  Container Port: $PORT"
echo "  AI Engine URL:  $AI_SERVICE_URL"
echo "==========================================================="

# Start Python AI Microservice on localhost port 5005 in background
echo "[Entrypoint] Launching Python 1D-CNN AI Engine on port 5005..."
python3 ml_engine/app.py &
PYTHON_PID=$!

# Graceful shutdown trap
cleanup() {
    echo "[Entrypoint] Caught termination signal. Shutting down..."
    kill -TERM "$PYTHON_PID" 2>/dev/null || true
    kill -TERM "$NODE_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# Wait for Python AI Engine to initialize
echo "[Entrypoint] Waiting for Python AI Engine to be healthy..."
MAX_TRIES=30
TRIES=0
until curl -s http://127.0.0.1:5005/health > /dev/null 2>&1 || [ $TRIES -eq $MAX_TRIES ]; do
    sleep 1
    TRIES=$((TRIES + 1))
done

if [ $TRIES -eq $MAX_TRIES ]; then
    echo "[Entrypoint] WARNING: Python AI Engine took longer than expected to start. Continuing..."
else
    echo "[Entrypoint] Python AI Engine is ready and healthy!"
fi

# Launch Node.js Cloud Hub in foreground
echo "[Entrypoint] Launching Node.js Cloud Hub on port $PORT..."
node cloud_server.js &
NODE_PID=$!

wait "$NODE_PID"
