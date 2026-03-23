#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill $(cat /home/nanoclaw/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/nanoclaw/nanoclaw"

# Stop existing instance if running
if [ -f "/home/nanoclaw/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/nanoclaw/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    # Wait for process to actually die (up to 10 seconds)
    for i in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Force killing PID $OLD_PID..."
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
  fi
fi

# Also kill anything still holding port 3001
fuser -k 3001/tcp 2>/dev/null || true
sleep 1

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/home/nanoclaw/nanoclaw/dist/index.js" \
  >> "/home/nanoclaw/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/nanoclaw/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/nanoclaw/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/nanoclaw/nanoclaw/logs/nanoclaw.log"
