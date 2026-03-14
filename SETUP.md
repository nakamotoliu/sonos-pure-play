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
openclaw browser tabs --browser-profile openclaw --json
```

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

## 5. Run a minimal smoke test

```bash
node scripts/run.mjs "卧室 播放 王力宏热门精选" "卧室"
```

## 6. Verify with CLI truth

```bash
sonos status --name "卧室"
sonos group status
```

If the room name is not exactly `卧室`, use your own discovered room name.
