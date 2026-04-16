---
name: sonos-pure-play
description: |-
  Sonos playback skill for room-targeted media requests using Sonos CLI for room/group verification and OpenClaw browser runtime for Sonos Web search and action clicks. Use when the user asks to play an artist, album, playlist, track, or mood-based music on Sonos in a specific room, especially when the flow should normalize grouped rooms before playback and verify success with Sonos CLI.
---

# Sonos Pure Play Skill

## Prerequisites
- Use a visible foreground browser session for Sonos Web automation. This skill must run against the frontmost user-facing browser window/tab, not a hidden/headless-only background browser.
- Default browser runtime profile is `openclaw` unless explicitly overridden for a visible foreground session.
- Distinguish the two profile concepts strictly:
  - CLI root `--profile <name>` switches the OpenClaw instance/state directory to `~/.openclaw-<name>`.
  - Browser CLI `--browser-profile <name>` selects the browser runtime profile.
  - Browser tool / browser.request field `profile` also means browser runtime profile, not CLI root profile.
- `OPENCLAW_BROWSER_PROFILE` only selects the browser runtime profile for `openclaw browser ...` actions. It does **not** switch the OpenClaw CLI global state directory.
- If CLI root `--profile` is omitted, commands use the current OpenClaw instance, usually `~/.openclaw`.
- If browser profile is omitted, browser uses the configured default browser profile, usually `openclaw`.
- The bundled browser plugin must be enabled and loadable (`plugins.allow` includes `browser`, `plugins.entries.browser.enabled=true`, `browser.enabled=true`).
- **First-time setup**: Log into Sonos Web (play.sonos.com) once in the visible browser profile used by this skill.
- Browser operations should go through the official OpenClaw browser runtime / CLI, not a custom CDP bridge.

## Browser profile hard rules
- Never use `openclaw browser ... --profile ...` for browser work.
- Always use `openclaw browser --browser-profile <name> ...` when calling the browser CLI directly.
- Wrong example: `openclaw browser tabs --profile openclaw`
  - This is wrong because it switches the OpenClaw state directory to `~/.openclaw-openclaw`.
- Correct examples:
  - `openclaw browser --browser-profile openclaw tabs`
  - `openclaw browser --browser-profile user tabs`
- If browser troubleshooting shows `gateway token missing` and the path points at `~/.openclaw-xxx`, check for accidental CLI root `--profile` misuse first.

## Core rule
- Use Sonos CLI as the source of truth for room resolution, group normalization, and playback verification.
- Use the official OpenClaw browser runtime for Sonos Web search, detail-page entry, menu reading, and playback action clicks.
- Prefer deterministic execution order over improvisation.

## Boundaries
### CLI only
- resolve target room
- inspect group status
- normalize grouped room to solo when needed
- inspect queue and playback state
- final truth verification

### Browser runtime only
- open Sonos Web in the selected visible foreground browser window/tab
- enter the search page and confirm login state
- enter search text through the shared input helper
- verify that the query remains visible in the search box
- inspect search results
- enter detail page
- open `更多选项`
- read menu items
- click `替换队列` or `立即播放`

## Fixed Agent Steps
The skill, not code, defines the business flow. Follow these steps in order and do not invent a different flow:

1. Resolve the exact target room with CLI tools from `scripts/cli-control.mjs`.
2. Inspect current group status with CLI tools and normalize the target room to solo when needed.
3. Capture preflight playback truth with CLI tools:
   - playback state
   - title / track
   - group
   - queue when needed
4. Use browser open tools from `scripts/browser-open-tools.mjs` to:
   - find/focus the visible Sonos tab
   - navigate to `https://play.sonos.com/zh-cn/search`
5. Use browser read tools from `scripts/browser-read-tools.mjs` to confirm:
   - the tab is on the expected page
   - login is not blocking the flow
6. Use browser read/action tools to sync Sonos Web active output to the CLI-resolved room.
7. Use input tools from `scripts/search-input-ops.mjs` and action tools from `scripts/browser-action-tools.mjs` to:
   - focus the visible search box
   - clear/replace the query
   - verify the query stayed in the box
8. Use page-surface tools from `scripts/browser-surface-tools.mjs` and read tools from `scripts/browser-read-tools.mjs` to inspect:
   - available inputs
   - service tabs
   - candidates
   - clickables
   - menu actions
   - visible rows
9. The agent selects which candidate to use based on those extracted blocks.
10. Use action tools to click the selected candidate and open the playable content area.
11. Use read tools and page-surface tools again to inspect the content area and determine whether:
   - `更多选项` is available
   - direct play is available
   - queue actions are visible
12. Use action tools to:
   - open `更多选项` when available
   - click `替换队列` first, otherwise `立即播放`
13. Use CLI tools and `scripts/verify.mjs` to verify final truth:
   - correct room
   - correct group state
   - playback state changed to `PLAYING` when expected
   - queue/title/track changed in a way consistent with the request

## Runtime Recovery Rules
- Recovery is allowed only inside the fixed flow above.
- Allowed recovery actions:
  - reread the current page
  - wait briefly and reread
  - reopen the fixed search page
  - rewrite the same query
- Not allowed:
  - invent a new business flow
  - invent new permanent selectors during a run
  - change code during the run

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
- `scripts/browser-open-tools.mjs` = browser page-opening/focus tools
- `scripts/browser-read-tools.mjs` = browser page-reading tools
- `scripts/browser-surface-tools.mjs` = extract usable page blocks for the agent
- `scripts/browser-action-tools.mjs` = browser click/input/touch tools
- `scripts/intent.mjs` = request split and intent analysis
- `scripts/query-planner.mjs` = media request to ordered search queries
- `scripts/cli-control.mjs` = Sonos CLI room/group/state helpers
- `scripts/browser-runner.mjs` = browser wrapper (calls official `openclaw browser --browser-profile ...` CLI via execFileSync)
- `scripts/search-input-ops.mjs` = shared input-box primitives for focus, replace, and verification
- `scripts/normalize.mjs` = shared normalization helpers
- `scripts/verify.mjs` = final playback verification
- `references/agent-protocol.md` = thin-primitives + lightweight-orchestrator protocol
- `references/ui-states.md` = web state model
- `references/phase-1-status.md` = current public status
