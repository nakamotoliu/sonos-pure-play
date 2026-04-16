# Setup

## 1. Install Sonos CLI
Use the installation method supported on your machine.
Then verify:

```bash
sonos discover
```

## 2. Prepare OpenClaw browser runtime
Make sure:
- OpenClaw gateway is running
- the browser runtime is available
- the chosen browser profile can access Sonos Web

Example check:

```bash
openclaw browser --browser-profile openclaw tabs
printenv OPENCLAW_BROWSER_PROFILE
```

Confirm that the printed `OPENCLAW_BROWSER_PROFILE` value is the browser runtime profile you intend to use.

Profile rules:
- CLI root `--profile <name>` switches the OpenClaw instance/state directory to `~/.openclaw-<name>`.
- Browser CLI must use `--browser-profile <name>`.
- Wrong example: `openclaw browser tabs --profile openclaw`
- Correct examples:
  - `openclaw browser --browser-profile openclaw tabs`
  - `openclaw browser --browser-profile user tabs`

## 3. Log into Sonos Web
Open Sonos Web in the browser profile you plan to use and complete login.

Recommended destination:

```text
https://play.sonos.com/zh-cn/web-app
```

## 4. Export environment variables

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
export OPENCLAW_BROWSER_PROFILE="openclaw"
```

`OPENCLAW_BROWSER_PROFILE` here means the browser runtime profile only. Do not use OpenClaw CLI global `--profile openclaw` for this skill.
If browser commands fail with `gateway token missing` and the path points at `~/.openclaw-xxx`, first check for mistaken CLI root `--profile` usage.

## 5. Run a minimal smoke test

Use the skill from the agent runtime. Do not rely on `scripts/run.mjs`; that script entry has been removed.

Runtime rules to keep:
- do not finish a media playback request through Sonos CLI alone
- do not inspect results until the query gate confirms the visible search box contains the requested query
- if verification reports a retryable playback failure, retry with a different result up to 3 total attempts
- the first completion message must be the full `Execution Report`, not a short success line

## 6. Verify with CLI truth

```bash
sonos status --name "卧室"
sonos group status
```

If the room name is not exactly `卧室`, use your own discovered room name.

Score note:
- any candidate score reported by the skill is a relative ranking/explanation score
- in `playlist-first` mode it is specifically a history-aware ordering score, not an absolute probability
