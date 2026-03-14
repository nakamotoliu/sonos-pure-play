it is not working# Sonos Direct Control (OpenClaw Skill)

Version: 3.0.0 (Schema-First)

## What this skill is
This is a schema-first Sonos skill for OpenClaw.
It is designed to make media playback behavior reproducible across different agents and environments.

## Core principle
This repository is not just "local instructions that happened to work once".
It defines a strict execution contract.

## Two modes
### 1. MEDIA_FLOW
Use for:
- searching songs/playlists/albums
- artist-based playback
- mood/theme playback
- queue replacement

**Mandatory dependency:** PageController

### 2. CONTROL_ONLY
Use for:
- pause / resume
- next / previous
- volume / mute
- grouping

This mode may use Sonos CLI without PageController.

## Mandatory requirements
For MEDIA_FLOW, users/agents must have:
1. OpenClaw browser runtime
2. PageController capability
3. Sonos Web login available in the configured browser profile
4. Sonos CLI installed and working
5. Ability to verify results with Sonos CLI

If we use PageController here, other agents must use it too.

## Official PageController reference
Other agents must read this before modifying/reusing the media-flow implementation:
- https://alibaba.github.io/page-agent/docs/advanced/page-controller

Do not guess how PageController should be used.

## How this skill actually uses PageController
PageController is used for:
1. locking the target room/output
2. reading fresh search-result state
3. filtering valid results and sources
4. verifying detail-page entry
5. opening the true action entry: `更多选项`
6. selecting playback actions before CLI verification

It is not just a keyboard helper.

## Hard execution order
For MEDIA_FLOW, the order is mandatory:
1. Resolve room
2. Lock room
3. Verify active output
4. Search / narrow intent
5. Open correct detail page
6. Open `更多选项`
7. Choose action by priority
8. CLI verify

## Hard action entry
The true playback-action entry is:
- `更多选项`

The menu behind it contains actions like:
- `替换当前歌单` / `替换播放列表` / `替换队列`
- `添加到队列末尾`
- `立即播放`

Do not treat search-result direct `播放XXX` buttons as the primary path.

## Hard action priority
1. `替换当前歌单` / `替换播放列表` / `替换队列`
2. `添加到队列末尾`
3. `立即播放`

## Playlist-vs-track rule
If you replace a playlist, Sonos usually starts from the playlist's first track.

So:
- broad artist/theme requests -> playlist replace is acceptable
- exact-song requests -> you must target the exact track and verify current track matches

## Source reliability note
- 网易云音乐: preferred
- QQ音乐: allowed but can fail at runtime

If QQ errors, do not pretend success. Use a stable alternative path.

## Install
```bash
brew install sonos
npm install
```

## Configure
```bash
cp config.json.example config.json
```

Adjust:
- `default_room`
- `browser_profile`
- `search_url`
- `page_agent_cdn`

## Verify
```bash
node scripts/self-check.mjs
```

## Run
```bash
bash scripts/sonos-v25-run.sh "关键词" "房间名"
```

## Final truth source
The browser is not the truth source.
Sonos CLI is the truth source.

Use:
- `sonos status --name "<room>"`
- `sonos queue list --name "<room>"`

If CLI does not confirm the requested result, the action did not succeed.
