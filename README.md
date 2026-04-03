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

- **Current version:** `0.2.3`
- **Delivery state:** stable enough for guided use, but not yet a zero-config public release
- **This iteration focus:** playlist-first candidate enforcement, copyright-restricted candidate rejection, stale-detail detection, CLI play fallback, and clearer verification acceptance signals

What works well now:
- room-targeted playback with explicit target room
- grouped-room normalization (`solo`) before playback
- search-state recovery (`close` / `back` / `home` -> re-enter search)
- playlist-first execution can now enforce playlist-only candidate execution when the planner asks for it
- copyright-restricted detail targets can now be rejected before playback action is issued
- CLI truth verification after web action, with a conservative `play` retry when replace-queue lands but transport does not start

Known limitations:
- `CONTROL_ONLY` path is not yet the focus of this open-source package
- Sonos Web UI can still behave inconsistently depending on account/service state
- final verification is intentionally conservative and may report failure in edge cases where Sonos changed too subtly

## What changed in 0.2.3

### Functional changes
- Playlist-first execution now filters the final execution pool so `allowedTypes=["playlist"]` does not accidentally execute song/artist candidates that scored earlier in raw ranking.
- Detail-page restriction scanning now checks the selected detail region and table rows for `版权受限` signals and rejects blocked candidates before menu action.
- Added stale-detail rejection to reduce cases where old room/now-playing residue poisons the selected detail page.
- Updated CLI verification so `替换队列` flows can issue a conservative `play` retry when transport does not reach `PLAYING` on its own.
- Verification now returns an `acceptedBy` field to distinguish queue-proof success from weaker fallback-signal success.

### Why this release exists
- Sonos Web was still selecting restricted or wrong-shape candidates for requests like `李荣浩 精选`.
- In practice, the UI could surface a restricted album-like result ahead of a real playlist, and transport could remain stopped after queue replacement.
- This iteration hardens the handoff between browser selection and CLI truth so the flow can skip restricted candidates and still recover playback.

### Validation evidence
- Real E2E rerun for `李荣浩 精选` in `客厅` skipped the restricted `華語歌曲精選集 - 李榮浩` path.
- The flow selected playlist `听李荣浩热门精选`, executed `替换队列`, and CLI verification ended in `PLAYING` with final title `不将就`.
- Verification succeeded via `acceptedBy: fallback-signals`, which is now explicitly exposed in logs.

### Known remaining gaps
- Raw ranking metadata can still list non-playlist candidates ahead of the final execution candidate; execution filtering now corrects that, but the ranking/debug payload is not yet fully normalized.
- Stale detail detection is still heuristic and may need further room-agnostic cleanup.
- Sonos Web DOM instability remains a real source of flakiness.

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
