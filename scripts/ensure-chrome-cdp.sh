#!/usr/bin/env bash
# ensure-chrome-cdp.sh — Ensure a CDP-enabled Chrome is running for Sonos automation.
#
# Uses a dedicated user-data-dir (~/.openclaw/browser/sonos-cdp/user-data)
# because Chrome requires a non-default data directory for remote debugging.
#
# On first run, the user must log into Sonos in this Chrome profile.
# Subsequent runs reuse the saved session.
#
# Usage: bash ensure-chrome-cdp.sh [--check-only]

PORT=${CDP_PORT:-9222}
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_DIR="$HOME/.openclaw/browser/sonos-cdp/user-data"

mkdir -p "$CDP_DIR"

# Check if CDP Chrome is already running and responsive
if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
  echo "Chrome CDP already running on port $PORT"
  exit 0
fi

if [ "$1" = "--check-only" ]; then
  echo "Chrome CDP not running on port $PORT"
  exit 1
fi

# Kill any existing Chrome that might block the port
if lsof -i ":$PORT" -P -n 2>/dev/null | grep -q LISTEN; then
  echo "Port $PORT is occupied. Killing existing listener..."
  lsof -ti ":$PORT" | xargs kill -9 2>/dev/null
  sleep 2
fi

echo "Launching Chrome with CDP on port $PORT (profile: sonos-cdp)"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins="*" \
  --no-first-run \
  --user-data-dir="$CDP_DIR" \
  &>/dev/null &

# Wait for Chrome to be ready
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
    echo "Chrome CDP ready on port $PORT"
    exit 0
  fi
  sleep 1
done

echo "Warning: Chrome launched but CDP endpoint not yet responding."
exit 0
