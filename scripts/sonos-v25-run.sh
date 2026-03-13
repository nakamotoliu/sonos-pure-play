#!/usr/bin/env bash
# sonos-v25-run.sh - PageController-powered Sonos discovery & control
# Usage: bash sonos-v25-run.sh "search query" "room name" "action"
set -euo pipefail

QUERY=${1:-}
ROOM=${2:-}
ACTION=${3:-"replace-first"} # replace-first, add-to-end, play-now

if [ -z "$QUERY" ] || [ -z "$ROOM" ]; then
    echo "Usage: $0 \"<query>\" \"<room>\" [action]"
    exit 1
fi

# 1. Resolve exact room name via CLI
# `sonos discover` prints tab-separated fields: <name> <ip> <udn>
# We must pass only the speaker name back to Sonos CLI.
echo "--- Resolving room: $ROOM ---"
DISCOVERY_LINE=$(sonos discover | awk -F'\t' -v room="$ROOM" 'BEGIN{IGNORECASE=1} $1 ~ room {print; exit}')
if [ -z "$DISCOVERY_LINE" ]; then
    echo "Error: Room '$ROOM' not found."
    exit 1
fi
EXACT_ROOM=$(printf '%s\n' "$DISCOVERY_LINE" | awk -F'\t' '{print $1}')
echo "Target: $EXACT_ROOM"

# 2. Browser/PageController gate
# This wrapper can orchestrate CLI truth checks, but the Web MEDIA_FLOW still
# requires a real browser runtime with PageController capability.
echo "--- Starting Browser Flow (PageController) ---"
if [ "${OPENCLAW_PAGECONTROLLER_READY:-}" != "1" ]; then
    echo "BLOCKED: MEDIA_FLOW requires an active browser runtime with PageController capability."
    echo "Planned web step: search '$QUERY' in Sonos Web for room '$EXACT_ROOM' using action '$ACTION'."
    echo "Hint: run the web portion from an OpenClaw browser session, then return here for CLI verification."
    echo "--- Current CLI state ---"
    sonos status --name "$EXACT_ROOM"
    exit 2
fi

# Final step placeholder: a future browser-capable runner may set this env and
# perform the page-side actions before handing back to CLI verification.
echo "PageController runtime ready."
echo "Plan: 1. Lock room -> 2. Search '$QUERY' -> 3. Open detail page -> 4. More Options -> 5. $ACTION"
echo "--- Verifying via CLI ---"
sonos status --name "$EXACT_ROOM"
