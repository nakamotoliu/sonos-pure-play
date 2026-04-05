# sonos-pure-play

Sonos playback skill for OpenClaw that uses:
- **Sonos CLI** for room resolution, group normalization, and final truth verification
- **OpenClaw browser runtime** for Sonos Web search, detail-page actions, and playback action clicks
- A **visible foreground browser session** as the required execution surface for Sonos Web actions

This skill is designed for **room-targeted media playback** such as:
- play an artist in a specific room
- play a playlist in a specific room
- play mood-based music in a specific room
- replace the current queue or start playback immediately

## Status

Current track: **Stable enough for guided use**, but not yet a zero-config public release.

What works well now:
- room-targeted playback with explicit target room
- grouped-room normalization (`solo`) before playback
- search-state recovery (`close` / `back` / `home` -> re-enter search)
- real-result filtering for playlist / album / mood-style content
- CLI truth verification after web action
- automatic failure screenshot capture of the current Sonos Web tab top-level visible root and Telegram delivery for whole-tab diagnosis

Known limitations:
- `CONTROL_ONLY` path is not yet the focus of this open-source package
- Sonos Web UI can still behave inconsistently depending on account/service state
- final verification is intentionally conservative and may report failure in edge cases where Sonos changed too subtly

## Required dependencies

### Required
1. **OpenClaw**
   - Used to run the skill and provide browser control
2. **OpenClaw browser runtime**
   - Used for Sonos Web search and UI actions
3. **Sonos CLI**
   - Used for room discovery, group status, solo normalization, queue/status verification
4. **A logged-in Sonos Web session in a visible foreground browser**
   - The browser profile used by this skill must already be able to access Sonos Web
   - The target tab/window must be user-visible and brought to the foreground during execution

### Optional
1. **Custom browser profile override**
   - Use `OPENCLAW_BROWSER_PROFILE` only if it still points to a visible foreground browser session

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
- `OPENCLAW_BROWSER_PROFILE` — optional browser-profile selector for `openclaw browser` only; defaults to `openclaw` for visible foreground execution

## Minimal run path

### 1. Install dependencies
- Install OpenClaw
- Install Sonos CLI
- Start the OpenClaw gateway/browser runtime
- Make sure the chosen browser profile is already logged into Sonos Web
- Make sure the Sonos tab can be shown in a real frontmost browser window

### 2. Configure environment
Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw"
```

`OPENCLAW_BROWSER_PROFILE` only controls the browser runtime profile used by browser actions. It does not switch the OpenClaw CLI global state directory.

### 3. Self-check
```bash
sonos discover
openclaw browser tabs
printenv OPENCLAW_BROWSER_PROFILE
```

You should confirm:
- `sonos discover` returns your speakers
- browser tabs command works
- `OPENCLAW_BROWSER_PROFILE` matches the browser runtime profile you intend to use
- a Sonos Web tab can be opened or already exists in that selected profile

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
- chosen browser runtime profile is available
- you are not accidentally invoking the OpenClaw CLI with a global `--profile <name>` override

### Sonos Web is not in a clean search state
Typical symptom:
- old detail page or stale search layer blocks new search

This skill already tries:
- close stale layer
- back
- home
- re-enter search
- bring the Sonos tab to a visible foreground browser target

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
