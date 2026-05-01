# sonos-pure-play

Sonos playback skill for OpenClaw.

This skill is for **room-targeted playback**. It uses:
- **Sonos CLI** for room resolution, group normalization, status checks, and playback truth verification
- **OpenClaw browser runtime** for Sonos Web search, detail-page actions, and playback clicks
- An **OpenClaw browser session** as the execution surface for Sonos Web, in either headed or headless mode

This package is intended for users who already have:
- OpenClaw working
- Sonos CLI working
- A usable Sonos Web login session in the browser profile they plan to use
- A local-only login recovery provider configured outside tracked files if they want automated login recovery

It is **not** a zero-config package.

## Hard Prerequisite

Before this skill can work reliably, the operator must have a usable OpenClaw browser runtime profile for Sonos Web.

Recommended default:
- browser runtime profile name: `openclaw-headless`
- `browser.profiles.openclaw-headless` present in `~/.openclaw/openclaw.json`
- `browser.profiles.openclaw-headless.headless=true`
- Sonos Web already logged in inside that profile

If `openclaw-headless` does not exist yet, do that first. Do not treat headless profile creation as an optional refinement.

Minimal browser profile config example:

```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "openclaw",
    "profiles": {
      "openclaw": {
        "cdpPort": 18800,
        "driver": "openclaw",
        "color": "#4285F4"
      },
      "openclaw-headless": {
        "cdpPort": 18801,
        "driver": "openclaw",
        "color": "#111827",
        "headless": true
      }
    }
  }
}
```

This skill uses `openclaw-headless` as the default browser runtime profile.

After adding the profile, continue with [SETUP.md](./SETUP.md).

## What This Skill Does

Typical use cases:
- play an artist in a specific room
- play a playlist in a specific room
- play mood-based music in a specific room
- replace the current queue or start playback immediately

The skill is designed around one rule:

**Do not trust page visuals alone. Final completion must be backed by Sonos CLI truth.**

## Current Status

Current status: **usable with operator guidance**

What is stable enough now:
- room-targeted playback with explicit room selection
- grouped-room normalization before playback
- search-state recovery when Sonos Web is stuck on stale layers
- candidate selection for playlist / album / mood-style searches
- CLI-backed verification after the web action
- failure screenshot capture for whole-tab diagnosis

Known limitations:
- Sonos Web can still behave inconsistently depending on account/service state
- if the selected browser profile is logged out, playback runs may stop until the operator restores a usable logged-in session
- OTP / unexpected identity-provider challenges are still blocking conditions
- login-page redirects are classified as browser-profile readiness failures, not as room-sync failures; stale Sonos login / identity-provider tabs are cleaned up when a usable app tab exists
- final verification is intentionally conservative and may report failure when Sonos changes are too subtle to prove
- this package is not focused on a CLI-only `CONTROL_ONLY` completion path

## Execution Contract

This skill follows a strict completion contract:
- do not complete a playback request through a CLI shortcut alone
- do not inspect results until the requested search query is visibly present
- use Sonos CLI as final truth for room/group/playback verification
- return the execution report only after playback verification is complete

The execution report should include at least:
- top candidate
- top candidate score
- chosen candidate
- chosen candidate score
- deviation
- decision reason
- playback verify result

Score notes:
- candidate scores are relative ranking scores used to explain ordering
- they are not a normalized percentage
- in playlist-oriented flows the score should be read as an ordering reason, not as absolute confidence

## Runtime Boundaries

### CLI-only steps
- resolve speaker / room name
- inspect group status
- force the target room to solo when grouped
- inspect queue / playback status
- perform final truth verification
- preflight inspection only; not a valid completion path for a playback request

### Browser-runtime-only steps
- open Sonos Web
- recover search state
- enter search text
- inspect search results
- enter detail page
- open `更多选项`
- click `替换队列` or `立即播放`

## Requirements

### Required
1. **OpenClaw**
2. **OpenClaw browser runtime**
3. **Sonos CLI**
4. **A created browser runtime profile for this skill, recommended: `openclaw-headless`**
5. **A logged-in Sonos Web session in that browser profile**

The browser profile used by this skill must:
- already be able to access Sonos Web
- expose the real Sonos Web tab the skill will operate on
- preserve a valid login session in the dedicated headless profile; use a separate headed/debug profile only when explicitly selected

If you enable automated login recovery, keep the provider implementation and recovery details in ignored local files. Do not publish provider names, helper paths, item names, or operator-specific recovery steps.

### Optional
1. **Custom browser profile override**
   - use `OPENCLAW_BROWSER_PROFILE` only if it still points to the intended browser runtime profile
2. **Headed/debug execution**
   - explicitly select another prepared profile, for example `OPENCLAW_BROWSER_PROFILE=openclaw`
   - keep this as an exception for debugging, not the skill default
3. **Optional runner-side override**
   - `OPENCLAW_BROWSER_HEADLESS=true` still forces skill-side headless detection before config lookup, but the preferred path is the dedicated headless profile

## Environment Variables

See `.env.example` for the minimal variable set.

Important variables:
- `OPENCLAW_GATEWAY_TOKEN`
  Required only when browser RPC is gateway-auth protected.
- `OPENCLAW_GATEWAY_URL`
  Optional. Defaults to the local gateway when supported by your runtime.
- `OPENCLAW_BROWSER_PROFILE`
  Optional browser-profile selector for `openclaw browser` commands only.
  Default: `openclaw-headless`
- `OPENCLAW_BROWSER_HEADLESS`
  Optional override for skill-side runtime detection.
  Accepted values: `true/false`, `1/0`, `yes/no`, `on/off`
- Local login-recovery provider variables
  Optional and deployment-specific. Keep exact provider names, item names, helper paths, and recovery steps in ignored local files, not in tracked documentation.

Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw-headless"
# Usually unnecessary when using openclaw-headless.
# export OPENCLAW_BROWSER_HEADLESS="true"
# Optional login recovery configuration belongs in ignored local files.
# Do not publish provider names, helper paths, item names, or recovery steps.
```

Important distinction:
- CLI root `--profile <name>` switches the OpenClaw instance/state directory to `~/.openclaw-<name>`
- Browser CLI `--browser-profile <name>` selects the browser runtime profile

Wrong example:

```bash
openclaw browser tabs --profile openclaw
```

Correct examples:

```bash
openclaw browser --browser-profile openclaw-headless tabs
openclaw browser --browser-profile user tabs
```

## Minimal Setup

1. Install OpenClaw
2. Install Sonos CLI
3. Create the browser runtime profile used by this skill, recommended: `openclaw-headless`
4. Start the OpenClaw gateway/browser runtime
5. Make sure the selected browser profile is usable for Sonos Web and already logged in before starting playback runs
6. Log into Sonos Web once in `openclaw-headless` so the headless profile has a valid session
7. For headed debugging, explicitly choose a separate prepared profile instead of changing the Sonos default

## Preflight Check

Before use, confirm:

```bash
sonos discover
openclaw browser --browser-profile openclaw-headless tabs
printenv OPENCLAW_BROWSER_PROFILE
```

Expected results:
- `sonos discover` returns your speakers
- browser tab inspection works
- `OPENCLAW_BROWSER_PROFILE` matches the intended browser runtime profile
- `openclaw-headless` already exists in `~/.openclaw/openclaw.json` if that is the selected profile
- a Sonos Web tab can be opened or already exists in that profile
- the runtime mode matches your expectation (`browser.profiles.openclaw-headless.headless=true`); avoid using global `browser.headless` for Sonos

## Run Path

Use the skill from the agent runtime.

Do **not** rely on `scripts/run.mjs`; that script entry is no longer part of the expected run path.

## Verification Standard

After the web action, verify with Sonos CLI:

```bash
sonos status --name "<your-room>"
sonos group status
```

Completion should be judged by:
- target room is correct
- grouped room is normalized if needed
- playback state is `PLAYING` or otherwise clearly changed as intended
- title / track / queue changed in a way consistent with the request

## Common Failure Modes

### Browser attach fails

Check:
- gateway is running
- gateway token is correct
- chosen browser runtime profile exists
- you are not accidentally invoking the OpenClaw CLI with a global `--profile <name>` override

If you see `gateway token missing` and the path points at `~/.openclaw-xxx`, first suspect accidental CLI root `--profile` misuse.

### Sonos Web is not in a clean search state

Typical symptom:
- old detail page or stale search layer blocks new search

This skill already tries:
- close stale layer
- back
- home
- re-enter search
- focus the Sonos tab only when running headed

If Sonos Web is badly stuck, manually refreshing the browser session may still help. In headless mode, that usually means briefly running the same profile headed, restoring login/state, then switching back.

### Sonos CLI truth does not move enough

Typical symptom:
- the web action appears to work, but CLI verification still says the observable change is too weak

This usually means one of two things:
- Sonos did not actually apply the action to the target room
- the action landed, but the CLI-visible signals changed too little to prove success

## Unsupported or Out-of-Scope

This README should be read as an operator-facing contract, not as a promise of full public plug-and-play support.

Out of scope:
- advanced login/session recovery beyond the direct visible Sonos login form
- a hidden/background browser flow without a prepared browser profile
- completion without CLI truth verification
- a no-setup consumer install path

## Privacy Boundary

This skill's maintained surface is the generic Sonos playback workflow only.

Included in the skill surface:
- room-targeted playback workflow
- browser profile setup requirements
- Sonos CLI verification flow
- generic playback ranking, search, detail-page, and verification helpers

Excluded from the skill surface:
- personal wakeup routines
- user-specific weekly music planning
- local playback history snapshots
- local logs, generated JSON state, and private operator artifacts

If a local automation depends on personal preferences or a private history file, keep it outside the maintained skill surface.

Local runtime artifacts:
- tab hints are local cache only and may be written under the operator's OpenClaw cache directory
- fallback snapshots must not persist freeform visible DOM text, typed input values, credentials, cookies, or account/session data
- logs and failure artifacts must stay generic or redacted before they are shared outside the machine

## Files Worth Knowing

- `SKILL.md`
  Agent-facing instructions and execution constraints
- `SETUP.md`
  Setup notes and operating assumptions
- `.env.example`
  Minimal configuration example
- `OSS_ALLOWLIST.md`
  Allowed public exceptions for OSS/privacy checks

## Update Log

This section is required by SOP. Every privacy/code-review update should append the specific change set here.


### 2026-05-01
- Tracking: OpenClaw 2026.4.29 browser-runtime compatibility fix before public push
- Changed:
  - load gateway client constants from the current `client-info-*` runtime module instead of the older message-channel bundle
  - keep hashed `call-*` module discovery for OpenClaw gateway RPC calls
- Impact:
  - Sonos browser smoke tests work again after OpenClaw runtime chunk/export changes
  - no credential, token, cookie, or operator-specific setup details added
- Validation:
  - `node --test scripts/*.test.mjs` passed 32/32
  - `GatewayBrowserClient.tabs()` and `openclaw browser --browser-profile openclaw-headless tabs` succeeded

### 2026-05-01
- Tracking: harden the weekday wakeup run after transient `room-sync-read-before` and copyright-unavailable stalls
- Changed:
  - allow the initial room-sync read to continue when the selected Sonos Web page does not currently expose the room card, while still failing closed for login/challenge states
  - require the final room-sync read after activation to confirm the target room is active; a merely visible room card is not enough to proceed
  - detect copyright/unavailable markers on a selected detail page before playback-menu handling and retry the next candidate instead of waiting for supervisor timeout
- Added:
  - retry-policy unit coverage for browser-surface copyright-blocked candidates
  - room-sync policy coverage proving final progression requires active-room confirmation
- Impact:
  - old detail pages without an open system/room panel no longer abort before the activation attempt
  - playback/search still cannot proceed unless Sonos Web confirms the requested room is active after activation
  - copyright-heavy playlists fail over faster to another candidate
- Validation:
  - `node --test scripts/*.test.mjs` passed 36/36
  - `GatewayBrowserClient.tabs()` succeeded

### 2026-04-29
- Tracking: login-preflight and privacy-compliance update before public push
- Changed:
  - classify Sonos login / identity-provider redirects as browser-profile readiness failures instead of room-sync/search/playback failures
  - clean stale Sonos login tabs when a usable Sonos app tab exists
  - keep credential-provider details out of tracked documentation and examples
- Added:
  - login-preflight unit coverage
  - retry metadata when verification retry hooks fail
- Removed:
  - public documentation of concrete credential-provider names, helper paths, item/search names, and operator-specific recovery steps
- Impact:
  - logged-out or challenged browser profiles now stop earlier with clearer setup errors
  - public docs stay generic and safer for external release
- Config/runtime impact:
  - no required public config change; optional login recovery remains local-only and ignored

### 2026-04-26
- Tracking: workspace state before the next public push
- Changed:
  - moved the default Sonos browser runtime profile to `openclaw-headless`
  - hardened browser tab reuse, search-page recovery, query-gate retries, and playback verification paths
  - changed the DOM snapshot fallback to return only redacted structural labels instead of freeform visible text or input values
- Added:
  - aria-snapshot helper tests and live diagnostic entrypoints for query/surface/playback checks
  - setup notes for the dedicated headless browser profile and CLI-vs-browser profile distinction
- Removed:
  - stale unit tests that no longer match the current live browser-runner architecture
  - global `browser.headless` guidance in favor of per-profile headless configuration
- Impact:
  - default background runs use the dedicated Sonos browser profile
  - privacy risk from fallback snapshots is reduced by omitting freeform DOM text and input values
- Config/runtime impact:
  - set `OPENCLAW_BROWSER_PROFILE=openclaw-headless` for Sonos browser runs
  - Sonos Web login/session readiness in that profile remains a prerequisite

### 2026-04-22
- Tracking: workspace state after Sonos privacy-boundary cleanup
- Changed:
  - removed operator-specific session workflow guidance from tracked docs
  - tightened the requirement that the chosen browser profile must already be usable for Sonos Web
- Added:
  - none
- Removed:
  - tracked auth/session handling guidance
- Impact:
  - tracked skill docs no longer describe operator-specific session procedures
  - playback runs now assume the selected browser profile is already prepared for Sonos Web
- Config/runtime impact:
  - login/session preparation remains an operator responsibility outside tracked skill docs

### 2026-04-20
- Tracking: workspace state after Sonos skill SOP review remediation
- Changed:
  - clarified the maintained privacy boundary of the skill
  - aligned the documentation with the current setup gate and publish scope
- Added:
  - README-level privacy-boundary guidance for included vs excluded assets
- Removed:
  - a user-specific wakeup planning helper from the maintained skill surface
- Impact:
  - removes user-specific wakeup planning logic from the maintained skill surface
  - reduces the risk of mixing local-only automation with the generic Sonos playback skill
- Config/runtime impact:
  - no required environment-variable change
  - no browser-profile requirement change
  - no playback verification contract change

### 2026-04-15
- Tracking: workspace commit `89b874a`
- Changed:
  - removed manual login helper test scripts from the tracked skill surface
  - added a skill-local `.gitignore`
- Added:
  - `skills/sonos-pure-play/.gitignore`
- Removed:
  - manual login helper test scripts
- Impact:
  - improves privacy posture for local/private skill maintenance
  - ensures local logs and generated JSON state remain ignored under the main skill directory
- Config/runtime impact:
  - no runtime entrypoint change
  - no required environment-variable change
  - no verification rule change

### 2026-04-15
- Tracking: workspace state aligned to review-fix commit family around `fc4d2d8` / `9890d47`
- Changed:
  - clarified browser surface/result handling notes
  - tightened documentation around execution contract, query visibility, and verification expectations
- Added:
  - README-level execution and verification clarifications
- Removed:
  - none in this README-only documentation pass
- Impact:
  - operators should understand more clearly that browser actions alone do not count as completion
- Config/runtime impact:
  - no new required variables introduced by this README rewrite
