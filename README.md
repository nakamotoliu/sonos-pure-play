# sonos-pure-play

Sonos playback skill for OpenClaw that uses:
- **Sonos CLI** for room resolution, group normalization, and final truth verification
- **OpenClaw browser runtime** for Sonos Web search, detail-page actions, and playback action clicks

This skill is designed for **room-targeted media playback** such as:
- play an artist in a specific room
- play a playlist in a specific room
- play mood-based music in a specific room
- replace the current queue or start playback immediately

## Status

- **Current version:** `0.2.0`
- **Delivery state:** stable enough for guided use, but not yet a zero-config public release
- **This iteration focus:** stronger long-intent recall, expanded-result selection, detail/direct-play branching, and verified playback-history writeback

What works well now:
- room-targeted playback with explicit target room
- grouped-room normalization (`solo`) before playback
- search-state recovery (`close` / `back` / `home` -> re-enter search)
- real-result filtering for playlist / album / mood-style content
- CLI truth verification after web action

Known limitations:
- `CONTROL_ONLY` path is not yet the focus of this open-source package
- Sonos Web UI can still behave inconsistently depending on account/service state
- final verification is intentionally conservative and may report failure in edge cases where Sonos changed too subtly

## What changed in 0.2.0

### Functional changes
- Added short-intent/recall query expansion in `scripts/query-planner.mjs`.
- Added original-intent token scoring in `scripts/candidate-ranker.mjs`.
- Added expanded-result (`查看所有` / `查看更多`) selection support in `scripts/web-flow.mjs`.
- Added zone-aware filtering so system controls and now-playing UI are less likely to pollute candidate extraction.
- Reworked result engagement into a state machine that can try detail-open, expand, and direct-play paths.

### Validation evidence
- Real Sonos E2E playback succeeded for a mood-style request with a post-play `volume=0` control step.
- CLI verification confirmed queue/title/track change after web action.
- Playback history is written only after verification succeeds.

### Known remaining gaps
- Detail-page classification still needs further de-noising.
- Expanded results can still misclassify some section/type combinations.
- Query compression is better than before but still not ideal for all long Chinese mood prompts.

## Required dependencies

### Required
1. **OpenClaw**
   - Used to run the skill and provide browser control
2. **OpenClaw browser runtime**
   - Used for Sonos Web search and UI actions
3. **Sonos CLI**
   - Used for room discovery, group status, solo normalization, queue/status verification
4. **A logged-in Sonos Web session**
   - The browser profile used by this skill must already be able to access Sonos Web

### Optional
1. **Custom browser profile override**
   - Use `OPENCLAW_BROWSER_PROFILE` if you do not want the default profile

## Runtime boundaries

### CLI-only steps
- resolve speaker / room name
- inspect group status
- force target room to solo when grouped
- inspect queue / playback status
- final truth verification

### Browser-runtime-only steps
- open Sonos Web
- recover search state
- enter search text
- inspect search results
- enter detail page
- open `更多选项`
- click `替换队列` or `立即播放`

## Environment variables

See `.env.example` for the minimal variable set.

Most important variables:
- `OPENCLAW_GATEWAY_TOKEN` — required if your browser RPC needs gateway auth
- `OPENCLAW_GATEWAY_URL` — optional; defaults to local gateway when your runtime supports it
- `OPENCLAW_BROWSER_PROFILE` — optional; defaults to `openclaw`

## Minimal run path

### 1. Install dependencies
- Install OpenClaw
- Install Sonos CLI
- Start the OpenClaw gateway/browser runtime
- Make sure the chosen browser profile is already logged into Sonos Web

### 2. Configure environment
Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw"
```

### 3. Self-check
```bash
sonos discover
openclaw browser tabs --browser-profile "$OPENCLAW_BROWSER_PROFILE" --json
```

You should confirm:
- `sonos discover` returns your speakers
- browser tabs command works
- a Sonos Web tab can be opened or already exists

### 4. Run
```bash
node scripts/run.mjs "卧室 播放 梁静茹的歌" "卧室"
```

### 5. Verify business truth
Do **not** trust page visuals alone.
Verify with CLI:

```bash
sonos status --name "<your-room>"
sonos group status
```

Success should be judged by:
- target room is correct
- grouped room is normalized if needed
- playback state is `PLAYING` or otherwise clearly changed as intended
- title / track / queue moved in a way consistent with the request

## Common failure modes

### Browser attach fails
Typical symptom:
- browser attach / tab commands fail

Check:
- gateway is running
- token is correct
- chosen browser profile is available

### Sonos Web is not in a clean search state
Typical symptom:
- old detail page or stale search layer blocks new search

This skill already tries:
- close stale layer
- back
- home
- re-enter search

But if Sonos Web is badly stuck, manually refreshing the browser session may still help.

### Sonos CLI truth does not move enough
Typical symptom:
- web action succeeds, but CLI verification still says the change is too weak to prove success

This means:
- either Sonos did not actually apply the action to the target room
- or the action landed but the observable CLI signals changed too little

## Intended audience

This package is best for users who:
- already use OpenClaw
- already have Sonos CLI working
- already have a usable Sonos Web login in the browser runtime

It is **not** intended as a plug-and-play package for users with no OpenClaw or Sonos CLI setup.
