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

It is **not** a zero-config package.

## Hard Prerequisite

Before this skill can work reliably, the operator must have a usable OpenClaw browser runtime profile for Sonos Web.

Recommended default:
- browser runtime profile name: `openclaw`
- `browser.profiles.openclaw` present in `~/.openclaw/openclaw.json`
- Sonos Web already logged in inside that profile

If `openclaw` does not exist yet, do that first. Do not treat profile creation as an optional refinement.

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
      }
    }
  }
}
```

This skill uses `openclaw` as the default browser runtime profile.

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
4. **A created browser runtime profile for this skill, recommended: `openclaw`**
5. **A logged-in Sonos Web session in that browser profile**

The browser profile used by this skill must:
- already be able to access Sonos Web
- expose the real Sonos Web tab the skill will operate on
- allow foreground focus when running headed, or preserve a valid login session when running headless

### Optional
1. **Custom browser profile override**
   - use `OPENCLAW_BROWSER_PROFILE` only if it still points to the intended browser runtime profile
2. **Recommended setup choice for background execution**
   - if you prefer background execution, set `browser.profiles.<name>.headless=true` in `~/.openclaw/openclaw.json` for the selected browser profile
   - Sonos reads profile-level `headless` first, then falls back to global `browser.headless`
   - this is a recommended setup option, not a hard requirement
3. **Optional runner-side override**
   - `OPENCLAW_BROWSER_HEADLESS=true` still forces skill-side headless detection before config lookup

## Environment Variables

See `.env.example` for the minimal variable set.

Important variables:
- `OPENCLAW_GATEWAY_TOKEN`
  Required only when browser RPC is gateway-auth protected.
- `OPENCLAW_GATEWAY_URL`
  Optional. Defaults to the local gateway when supported by your runtime.
- `OPENCLAW_BROWSER_PROFILE`
  Optional browser-profile selector for `openclaw browser` commands only.
  Default: `openclaw`
- `OPENCLAW_BROWSER_HEADLESS`
  Optional override for skill-side runtime detection.
  Accepted values: `true/false`, `1/0`, `yes/no`, `on/off`

Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw"
export OPENCLAW_BROWSER_HEADLESS="false"
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
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile user tabs
```

## Minimal Setup

1. Install OpenClaw
2. Install Sonos CLI
3. Create the browser runtime profile used by this skill, recommended: `openclaw`
4. Start the OpenClaw gateway/browser runtime
5. Make sure the selected browser profile is usable for Sonos Web and already logged in before starting playback runs
6. If running headed, make sure the Sonos tab can be brought to a real frontmost browser window
7. If running headless, prefer a browser profile that already holds a valid Sonos Web login session for more reliable background execution

## Preflight Check

Before use, confirm:

```bash
sonos discover
openclaw browser --browser-profile openclaw tabs
printenv OPENCLAW_BROWSER_PROFILE
```

Expected results:
- `sonos discover` returns your speakers
- browser tab inspection works
- `OPENCLAW_BROWSER_PROFILE` matches the intended browser runtime profile
- `openclaw` already exists in `~/.openclaw/openclaw.json` if that is the selected profile
- a Sonos Web tab can be opened or already exists in that profile
- the runtime mode matches your expectation (`browser.profiles.<name>.headless`, `browser.headless`, or `OPENCLAW_BROWSER_HEADLESS=...`)

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
