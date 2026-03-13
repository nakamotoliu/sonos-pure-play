# Page-Agent v2.5 Integration (Sonos Direct OpenClaw)

## Objective
Use Page-Agent for all Sonos Web App interaction steps while preserving CLI as the verification source of truth.

## Runtime Contract
- Web actions: Page-Agent only
- Verification: Sonos CLI only
- Fallbacks: none (fail fast with reason)

## Required Environment (gateway-auth mode)
- Gateway token source (one of):
  - `OPENCLAW_GATEWAY_TOKEN` (preferred)
  - `~/.openclaw/openclaw.json` -> `gateway.auth.token` (auto fallback)
- `OPENCLAW_GATEWAY_URL` (optional, default: `http://127.0.0.1:18789`)
  - Note: default is local-only; remote gateway deployments must set this explicitly.

Derived at runtime:
- `baseURL = OPENCLAW_GATEWAY_URL + /v1`

Required:
- `PAGE_AGENT_MODEL` (must be explicitly set by runtime/agent, e.g. `qwen3.5-plus`)

Legacy note:
- `PAGE_AGENT_API_KEY` / `PAGE_AGENT_BASE_URL` are no longer primary inputs in this skill.

## Menu Decision Rule
Priority order:
1. `替换队列`
2. `添加到队列末尾`
3. `立即播放` (only with explicit user consent)

## Verification Rule
- Queue path success: `q1 != q0`
- Immediate-play success: `State=PLAYING` and time advances in 10s window

## Current Deliverables
- `scripts/page-agent-web-flow.mjs`: Page-Agent web flow runner (search/select/menu)
- `scripts/sonos-v25-run.sh`: orchestration wrapper (CLI baseline + verification)

## Next Upgrade
- Add telemetry JSON output: action, latency, outcome, failure step
- Add deterministic retry cap: max 2 retries per web step
