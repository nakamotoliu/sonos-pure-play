# sonos-direct-openclaw

Sonos playback skill for OpenClaw.

This repository is the open-source export target for a Sonos playback workflow that combines:
- **Sonos CLI** for room resolution, group inspection, and truth verification
- **OpenClaw browser runtime** for Sonos Web actions
- a **visible foreground browser session** for reliable Sonos Web operation

This package is intended for users who already have:
- OpenClaw working
- Sonos CLI working
- Sonos Web login available in the browser profile they plan to use

It is **not** a zero-config consumer package.

## What This Package Does

Typical use cases:
- play content in a specific room
- replace the current queue
- play playlist / artist / mood-based content
- run browser-assisted Sonos playback with CLI verification

Core rule:

**Do not treat browser visuals alone as success. Final completion must be backed by Sonos CLI truth.**

## Current Status

Current status: **operator-oriented and contract-driven**

What is stable enough now:
- room-targeted playback with explicit room selection
- browser-assisted Sonos Web action flow
- CLI-backed final verification
- contract-first operation for media playback requests

Known limitations:
- this repo assumes Sonos Web is already logged in and usable
- browser/runtime state still matters for success
- verification is intentionally strict and may reject weak observable state changes
- this package is aimed at guided operator use, not generic plug-and-play distribution

## Execution Contract

This repository follows a strict execution contract:
- do not complete a playback request through a CLI shortcut alone
- use Sonos CLI as final truth for room/group/playback verification
- prefer menu-driven playback actions over unreliable direct result clicks
- treat the final report as complete only after playback verification

## Requirements

### Required
1. **OpenClaw**
2. **OpenClaw browser runtime**
3. **Sonos CLI**
4. **A logged-in Sonos Web session in a visible foreground browser**

### Additional assumptions
- the selected browser profile can access Sonos Web
- the Sonos tab can be brought to the foreground during execution
- the local environment can run browser actions and Sonos CLI checks together

## Environment and Config

This repo currently ships:
- `config.json.example`
- package metadata
- execution scripts under `scripts/`

If your runtime needs gateway auth, you may also need environment variables such as:
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_GATEWAY_URL`
- browser-profile selection variables supported by your OpenClaw setup

Example values shown in docs are placeholders only and must be replaced in your own local environment.

## Run and Verify

Run path depends on the scripts in this repo.

Important files:
- `scripts/sonos-v25-run.sh`
- `scripts/page-agent-web-flow.mjs`
- `scripts/self-check.mjs`

Verify truth with Sonos CLI, for example:

```bash
sonos status --name "<room>"
sonos queue list --name "<room>"
```

Only claim success if CLI confirms the expected room/content change.

## Common Failure Modes

### Browser attach/runtime problems

Check:
- gateway is running
- gateway auth is correct if required
- chosen browser profile exists
- Sonos Web is already logged in and usable

### Sonos Web state is stale

Typical symptom:
- stale page state blocks new search/action flow

Typical recovery:
- reopen the correct tab
- bring the target browser window to the foreground
- refresh or re-enter the action flow

### CLI truth does not move enough

Typical symptom:
- browser action looks successful, but CLI signals do not clearly confirm the intended playback change

This should be treated as failure or partial failure, not silent success.

## Repository Files

- `SKILL.md`
  Agent-facing execution contract
- `config.json.example`
  Example local configuration
- `scripts/sonos-v25-run.sh`
  Primary script entry in this export repo
- `scripts/page-agent-web-flow.mjs`
  Browser-side helper path
- `scripts/self-check.mjs`
  Minimal self-check helper
- `references/page-controller-sop.md`
  Operational reference for the browser-assisted flow

## Update Log

This section is required by SOP. Every push/open-source update must append the specific change set here.

### 2026-04-15
- Tracking:
  - workspace commits `89b874a` and `a821554`
- Changed:
  - updated the repository README to follow SOP-required documentation structure
  - added explicit execution/status/requirements/verification sections
  - added a persistent update-log section for future pushes
  - aligned ignore rules for export-repo local artifacts
- Added:
  - README update-log structure
  - ignore coverage for export-repo local log/data artifacts
- Removed:
  - obsolete README wording that did not match the new SOP documentation format
- Impact:
  - operators can now see the current contract, requirements, and verification standard in one place
  - future export updates must record their specific changes in this README
- Config/runtime impact:
  - no new runtime entrypoint introduced by this documentation update
  - no required credential value is stored in the repository
