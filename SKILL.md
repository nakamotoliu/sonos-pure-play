---
name: sonos-pure-play
description: |-
  Sonos playback skill for room-targeted media requests using Sonos CLI for room/group verification and OpenClaw browser runtime for Sonos Web search and action clicks. Use when the user asks to play an artist, album, playlist, track, or mood-based music on Sonos in a specific room, especially when the flow should normalize grouped rooms before playback and verify success with Sonos CLI.
---

# Sonos Pure Play Skill

## Prerequisites
- Use an OpenClaw browser session that matches the runtime mode:
  - headed mode: a visible foreground browser session is allowed and may be focused during execution
  - headless mode: a hidden browser session is also supported; Sonos Web must already be logged in in that browser profile
- Default browser runtime profile is `openclaw` unless explicitly overridden for the chosen browser session.
- The recommended first-time operator setup is:
  - use `browser.profiles.openclaw` in `~/.openclaw/openclaw.json`
  - keep that profile usable for this skill's browser flow
  - choose headed or headless based on operator preference; headless is a recommended setup choice for background runs, not a hard requirement
  - verify that same browser profile already has a usable Sonos Web session before relying on this skill
- Distinguish the two profile concepts strictly:
  - CLI root `--profile <name>` switches the OpenClaw instance/state directory to `~/.openclaw-<name>`.
  - Browser CLI `--browser-profile <name>` selects the browser runtime profile.
  - Browser tool / browser.request field `profile` also means browser runtime profile, not CLI root profile.
- `OPENCLAW_BROWSER_PROFILE` only selects the browser runtime profile for `openclaw browser ...` actions. It does **not** switch the OpenClaw CLI global state directory.
- If CLI root `--profile` is omitted, commands use the current OpenClaw instance, usually `~/.openclaw`.
- If browser profile is omitted, browser uses the configured default browser profile, usually `openclaw`.
- The bundled browser plugin must be enabled and loadable (`plugins.allow` includes `browser`, `plugins.entries.browser.enabled=true`, `browser.enabled=true`).
- **First-time setup**: Log into Sonos Web (play.sonos.com) once in the browser profile used by this skill.
- Browser operations should go through the official OpenClaw browser runtime / CLI, not a custom CDP bridge.
- Keep secrets and machine-specific handling details out of tracked skill files.

## Preflight gate
- Before starting any playback workflow, the agent should treat browser-profile readiness as a hard gate.
- The agent should confirm:
  - the selected browser runtime profile exists, recommended default: `openclaw`
  - the profile is the one intended by `OPENCLAW_BROWSER_PROFILE` or the active runner configuration
  - Sonos Web is already logged in and usable in that profile
- If the selected profile itself is missing, browser runtime is not usable, or Sonos Web is logged out in that profile, do not continue into search, candidate selection, or playback actions.
- Stop early and direct the operator to:
  - [README.md](./README.md)
  - [SETUP.md](./SETUP.md)
- Missing browser/profile setup or missing Sonos session is an operator-preparation problem.
- Do not treat headless itself as a preflight requirement; readiness is about a usable prepared profile, not a forced runtime mode.

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
- Media playback requests must not be completed through a CLI shortcut alone.
- For any request whose goal is to play specific content, CLI may help with room resolution, group normalization, and final verification, but it must not replace the browser search -> candidate selection -> decision report -> playback action flow.

## Boundaries
### CLI only
- resolve target room
- inspect group status
- normalize grouped room to solo when needed
- inspect queue and playback state
- final truth verification
- preflight inspection only; not a completion path for media playback requests

### Browser runtime only
- open Sonos Web in the selected browser window/tab or headless target
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

0. Run the preflight gate:
   - confirm the selected browser runtime profile exists, recommended default: `openclaw`
   - confirm the chosen profile is the same profile the browser runner will use
   - confirm Sonos Web is already logged in and usable in that profile
   - if not ready, stop and direct the operator to `README.md` and `SETUP.md`
1. Resolve the exact target room with CLI tools from `scripts/cli-control.mjs`.
2. Inspect current group status with CLI tools and normalize the target room to solo when needed.
3. Capture preflight playback truth with CLI tools:
   - playback state
   - title / track
   - group
   - queue when needed
4. Use browser open tools from `scripts/browser-open-tools.mjs` to:
   - find the Sonos tab and focus it only when the browser is running in headed mode
   - navigate to `https://play.sonos.com/zh-cn/search`
5. Use browser read tools from `scripts/browser-read-tools.mjs` to confirm:
   - the tab is on the expected page
   - login is not blocking the flow
   - if login is blocking the flow, stop and report that the browser profile is not ready
6. Use browser read/action tools to sync Sonos Web active output to the CLI-resolved room.
7. Use input tools from `scripts/search-input-ops.mjs` and action tools from `scripts/browser-action-tools.mjs` to:
   - focus the search box
   - clear/replace the query
   - verify the query stayed in the box with the query gate
   - if the query gate is false, retry inside the allowed recovery flow and do not move to result inspection yet
8. Use page-surface tools from `scripts/browser-surface-tools.mjs` and read tools from `scripts/browser-read-tools.mjs` to inspect:
   - available inputs
   - service tabs
   - candidates
   - `selectionSummary`
   - clickables
   - menu actions
   - visible rows
9. The agent selects which candidate to use based on those extracted blocks.
   - default preference order is: playlist first, then album, then song, unless the request is explicitly a song/album/artist request
   - if any candidate has `recommended === true`, the agent must choose from that subset only
   - if no candidate has `recommended === true`, the agent must choose the candidate with the highest `finalScore`
   - use `buildSelectionDecisionReport(...)` to produce the decision report before clicking when possible
   - before clicking, the agent should explicitly report:
     - top recommended candidate title + score
     - actual chosen candidate title + score
     - whether the choice deviates from the top recommendation
     - the reason for the final choice
   - if the chosen candidate is not the top recommended one, or not the top scored candidate when no recommendation exists, the deviation reason must be stated explicitly
10. Use action tools to click the selected candidate and open the playable content area.
11. Use read tools and page-surface tools again to inspect the content area and determine whether:
   - `更多选项` is available
   - direct play is available
   - queue actions are visible
12. Use the dedicated playback-menu action helper from `scripts/browser-action-tools.mjs` via the browser runner:
   - call `openPlaybackActionMenu(...)` to open `更多选项` and confirm the expected playback actions became visible
   - then call `choosePlaybackAction(...)` to click `替换队列` first, otherwise `立即播放`
   - do not use generic `clickButtonByLabel(...)` or ad hoc browser evaluate/click for this playback-menu step
13. Use CLI tools and `scripts/verify.mjs` to verify final truth:
   - correct room
   - correct group state
   - playback state changed to `PLAYING` when expected
   - queue/title/track changed in a way consistent with the request
   - if verification indicates a retryable playback failure such as copyright/transition/no content match, select a different result and retry
   - total playback attempts per query are capped at 3
   - if verification failure is retryable, continue trying different candidates until the retry limit is reached
   - if the failure is non-retryable, stop and send the final report immediately
14. End every run with a short execution report to the user.
   - the run is not complete until the report is sent
   - the execution report is the only valid completion message
   - do not send a short confirmation before the report
   - the first user-visible success message must be the full execution report
   - success and failure runs both require the same full report skeleton
   - if any required field is missing, the run is not complete
   - the report must include:
      - top recommended candidate + score when available
      - chosen candidate + score when available
      - deviation yes/no
      - one-line decision reason
      - playback verification result
   - use this exact report skeleton:
     - `Execution Report`
     - `Top candidate: ...`
     - `Top candidate score: ...`
     - `Chosen candidate: ...`
     - `Chosen candidate score: ...`
     - `Deviation: yes/no`
     - `Decision reason: ...`
     - `Playback verify result: ...`

## Runtime Recovery Rules
- Recovery is allowed only inside the fixed flow above.
- Allowed recovery actions:
  - reread the current page
  - wait briefly and reread
  - reopen the fixed search page
  - rewrite the same query
  - reopen the playback menu through `openPlaybackActionMenu(...)` when the action surface is missing or stale
  - when playback verification reports a retryable failure, choose a different result and rerun the playback branch
- The first hard gate is query confirmation:
  - use `checkSearchQueryApplied(...)` or `ensureQueryGate(...)`
  - do not inspect results until the query gate is true
  - if the query gate never becomes true, stop with `QUERY_NOT_CONFIRMED`
- The final hard output rule is the execution report:
  - do not end the run with a bare `done`, `already playing`, or any other short confirmation
  - do not send a short confirmation before the report
  - the first user-visible success message must be the full execution report
  - use the same report shape for success and failure
- Not allowed:
  - invent a new business flow
  - invent new permanent selectors during a run
  - bypass the dedicated playback-menu helper with a generic click path
  - persist secrets or machine-specific handling instructions into tracked files
  - change code during a playback run

## Current support
- explicit target-room playback requests
- artist / album / playlist / mood-like media requests
- grouped-room normalization before playback
- JSON-log phase tracing for debugging

## Deferred scope
- richer ambiguity handling for very broad requests
- polished public `CONTROL_ONLY` coverage
- login/session preparation beyond requiring an already usable browser profile

## Publish boundary
- This skill's tracked/public surface is the generic Sonos playback workflow only.
- Do not add user-specific wakeup planners, personal rotation scripts, or private preference generators to this skill surface.
- Keep local-only automations and private operator routines outside the maintained skill directory, or exclude them explicitly before commit/push.

## Skill layout
- `scripts/browser-open-tools.mjs` = browser page-opening/focus tools
- `scripts/browser-read-tools.mjs` = browser page-reading tools
- `scripts/browser-surface-tools.mjs` = extract usable page blocks for the agent
  - includes enriched candidates with history/score/recommendation fields and `selectionSummary`
- `scripts/browser-action-tools.mjs` = browser click/input/touch tools
  - also includes dedicated playback-menu helpers: `openPlaybackActionMenu(...)` and `choosePlaybackAction(...)`
- `scripts/intent.mjs` = request split and intent analysis
- `scripts/query-planner.mjs` = media request to ordered search queries
- `scripts/cli-control.mjs` = Sonos CLI room/group/state helpers
- `scripts/browser-runner.mjs` = browser wrapper (calls official `openclaw browser --browser-profile ...` CLI via execFileSync)
- `scripts/search-input-ops.mjs` = shared input-box primitives for focus, replace, query-gate verification, and light retry
- `scripts/normalize.mjs` = shared normalization helpers
- `scripts/verify.mjs` = final playback verification
- `references/ui-states.md` = web state model
- `references/phase-1-status.md` = current public status
