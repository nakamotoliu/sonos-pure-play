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

Recommended profile for this skill:
- browser runtime profile name: `openclaw`
- use this as the default profile name unless you have a strong reason to override it

If `openclaw` does not exist yet in `~/.openclaw/openclaw.json`, create it first.

Minimal example:

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

Notes:
- `profiles.openclaw` is the important part for this skill
- you do not need to change `browser.defaultProfile` if your normal default should stay `openclaw`
- headless is optional for this skill, not required; if you want background execution, you can set `headless: true` at the profile level as a recommended setup choice
- headed mode is also supported when you want visible debugging or manual observation
- if your config already has a `browser` section, merge this into it instead of replacing unrelated keys

Example check:

```bash
openclaw browser --browser-profile openclaw tabs
printenv OPENCLAW_BROWSER_PROFILE
```

Confirm that the printed `OPENCLAW_BROWSER_PROFILE` value is the browser runtime profile you intend to use.
Also confirm that your config file contains `browser.profiles.openclaw` when that is the profile you plan to use.

Profile rules:
- CLI root `--profile <name>` switches the OpenClaw instance/state directory to `~/.openclaw-<name>`.
- Browser CLI must use `--browser-profile <name>`.
- Wrong example: `openclaw browser tabs --profile openclaw`
- Correct examples:
  - `openclaw browser --browser-profile openclaw tabs`
  - `openclaw browser --browser-profile user tabs`

## 3. Log into Sonos Web
Open Sonos Web in the browser profile you plan to use and complete login.

Login/session rule:
- Sonos Web should already be logged in in the browser profile used by this skill.
- Tracked skill files must not contain secrets or machine-specific handling instructions.
- Any local-only helper mapping or cached auth artifacts must stay in ignored paths only.

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
`OPENCLAW_BROWSER_HEADLESS` is optional and usually unnecessary when using the default `openclaw` profile.

## 5. Run a minimal smoke test

Use the skill from the agent runtime. Do not rely on `scripts/run.mjs`; that script entry has been removed.

Login expectation:
- If Sonos Web is unexpectedly logged out, stop and report that the selected browser profile is not ready.
- If Sonos shows an OTP / external challenge page, stop and report the block instead of faking success.

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
