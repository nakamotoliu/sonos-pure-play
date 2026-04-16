# sonos-pure-play

Sonos playback skill for OpenClaw.

This skill is for **room-targeted playback**. It uses:
- **Sonos CLI** for room resolution, group normalization, status checks, and playback truth verification
- **OpenClaw browser runtime** for Sonos Web search, detail-page actions, and playback clicks
- A **visible foreground browser session** as the execution surface for Sonos Web

This package is intended for users who already have:
- OpenClaw working
- Sonos CLI working
- A usable Sonos Web login session in the browser profile they plan to use

It is **not** a zero-config package.

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
- this package assumes Sonos Web is already logged in and usable
- Sonos Web can still behave inconsistently depending on account/service state
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
- browser action feedback
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
- reread browser state after the action click and confirm a visible success signal before trusting the action

## Browser Action Feedback

After clicking `替换队列`, `立即播放`, or `添加到队列末尾`, do not assume the action worked just because the click call returned.

At least one browser-side success signal should appear before the flow proceeds to final CLI verification:
- the action dialog closes
- the detail-page primary button changes from `播放...` to `暂停...`
- the `正在播放` region updates to the requested content
- the target room card in system view updates to the requested content

If none of those signals appear, the flow should reread after a short wait and treat the action as unconfirmed rather than silently continuing.

## Requirements

### Required
1. **OpenClaw**
2. **OpenClaw browser runtime**
3. **Sonos CLI**
4. **A logged-in Sonos Web session in a visible foreground browser**

The browser profile used by this skill must:
- already be able to access Sonos Web
- be allowed to come to the foreground during execution
- expose the real Sonos Web tab the skill will operate on

### Optional
1. **Custom browser profile override**
   - use `OPENCLAW_BROWSER_PROFILE` only if it still points to a visible foreground browser session

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

Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw"
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
3. Start the OpenClaw gateway/browser runtime
4. Make sure the selected browser profile is already logged into Sonos Web
5. Make sure the Sonos tab can be brought to a real frontmost browser window

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
- a Sonos Web tab can be opened or already exists in that profile

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
- bring the Sonos tab to a visible foreground browser target

If Sonos Web is badly stuck, manually refreshing the browser session may still help.

### Sonos CLI truth does not move enough

Typical symptom:
- the web action appears to work, but CLI verification still says the observable change is too weak

This usually means one of two things:
- Sonos did not actually apply the action to the target room
- the action landed, but the CLI-visible signals changed too little to prove success

## Unsupported or Out-of-Scope

This README should be read as an operator-facing contract, not as a promise of full public plug-and-play support.

Out of scope:
- automatic full login/session recovery when Sonos Web is not already usable
- a headless-only hidden browser flow
- completion without CLI truth verification
- a no-setup consumer install path

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

This section is required by SOP. Every push/open-source update must append the specific change set here.

### 2026-04-15
- Tracking: workspace commit `89b874a`
- Changed:
  - removed login helper test scripts that accepted Sonos credentials for manual login testing
  - added a skill-local `.gitignore`
- Added:
  - `skills/sonos-pure-play/.gitignore`
- Removed:
  - `scripts/test-login-input.mjs`
  - `scripts/test-okta-login-input.mjs`
- Impact:
  - improves privacy posture for export/open-source use
  - ensures local logs and generated JSON state remain ignored even when the skill is exported as a standalone repo
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
