---
name: sonos-pure-play
description: |-
  Sonos playback skill for room-targeted media requests using Sonos CLI for room/group verification and OpenClaw browser runtime for Sonos Web search and action clicks. Use when the user asks to play an artist, album, playlist, track, or mood-based music on Sonos in a specific room, especially when the flow should normalize grouped rooms before playback and verify success with Sonos CLI.
---

# Sonos Pure Play Skill

## Core rule
- Use Sonos CLI as the source of truth for room resolution, group normalization, and playback verification.
- Use OpenClaw browser runtime for Sonos Web search, detail-page entry, menu reading, and playback action clicks.
- Prefer deterministic execution order over improvisation.

## Boundaries
### CLI only
- resolve target room
- inspect group status
- normalize grouped room to solo when needed
- inspect queue and playback state
- final truth verification

### Browser runtime only
- open Sonos Web
- recover search state
- enter search text
- inspect search results
- enter detail page
- open `更多选项`
- read menu items
- click `替换队列` or `立即播放`

## Execution rules
1. Resolve the exact target room first.
2. If the target room is grouped, normalize it to solo before any web media action.
3. Recover Sonos Web into a usable search state before entering a query.
4. Sync Sonos Web active output toward the CLI-resolved target room before acting on media.
5. Use focus + clipboard + paste as the primary search-input path.
6. Treat search results/history as a live page; treat input-only changes with no rendered state as a dead page.
7. Filter out room/group/transport noise before selecting a search result.
8. Enter the first acceptable result, then open `更多选项`.
9. Choose `替换队列` first when available; otherwise choose `立即播放`.
10. Verify success with Sonos CLI truth rather than trusting page visuals alone.

## Current support
- explicit target-room playback requests
- artist / album / playlist / mood-like media requests
- grouped-room normalization before playback
- JSON-log phase tracing for debugging

## Deferred scope
- richer ambiguity handling for very broad requests
- polished public `CONTROL_ONLY` coverage
- full login/session recovery when Sonos Web is not already usable

## Skill layout
- `scripts/run.mjs` = orchestration entry
- `scripts/intent.mjs` = request split and intent analysis
- `scripts/query-planner.mjs` = media request to ordered search queries
- `scripts/cli-control.mjs` = Sonos CLI room/group/state helpers
- `scripts/browser-runner.mjs` = OpenClaw browser wrapper
- `scripts/web-flow.mjs` = web state machine
- `scripts/normalize.mjs` = shared normalization helpers
- `scripts/verify.mjs` = final playback verification
- `references/migration-map.md` = design summary
- `references/ui-states.md` = web state model
- `references/phase-1-status.md` = current public status
