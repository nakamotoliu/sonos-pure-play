---
name: sonos-direct-openclaw
version: 3.0.0
description: |-
  Schema-first Sonos media/control skill for OpenClaw without Browser Relay. Use for Sonos playback, room targeting, queue replacement, playlist playback, and volume/control operations. MEDIA_FLOW requires PageController capability and must follow the locked execution contract: lock room first, verify active output, search/select content, use the 更多选项 dialog as the action entry, then CLI-verify success. CONTROL_ONLY requests may use CLI without PageController.
---

# Sonos Direct Control (V3.0 - Schema-First)

This skill is intentionally contract-driven.
It is designed to reduce agent improvisation.

## 0. Execution baseline (must-read)

This skill runs in **gateway-auth + OpenClaw browser** mode.

Mandatory setup for all agents:
1. `OPENCLAW_GATEWAY_TOKEN` must be present
2. `OPENCLAW_GATEWAY_URL` defaults to `http://127.0.0.1:18789` when unset (local-only default; set explicitly for remote gateway)
3. `PAGE_AGENT_MODEL` must be explicitly set (no silent model fallback)
4. `gateway.http.endpoints.chatCompletions.enabled` must be `true`
5. Browser path is OpenClaw-managed browser tooling (no Browser Relay dependency)

Do not treat `PAGE_AGENT_API_KEY` as a primary credential in this skill.

## 1. Two modes only

### A. MEDIA_FLOW
Use for:
- search and play by song / artist / album / playlist
- play by mood / scene / theme
- replace current queue/content

**Hard requirement:** PageController capability is mandatory.
If PageController is unavailable, do not pretend this flow is supported.

### B. CONTROL_ONLY
Use for:
- pause / resume
- next / previous
- volume
- mute
- grouping

This mode may use Sonos CLI only.

---

## 2. Hard dependency schema
For MEDIA_FLOW, all of the following are required:
1. OpenClaw browser runtime (profile `openclaw`)
2. PageController capability in browser page context
3. Sonos Web App logged in under the OpenClaw browser profile
4. Gateway auth env (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_URL`)
5. `gateway.http.endpoints.chatCompletions.enabled=true`
6. Sonos CLI working locally
7. CLI verification after browser-side action

If any of these are missing, do not claim the request is fully supported.

---

## 3. Hard execution-order schema
For MEDIA_FLOW, use this exact order:
1. Resolve target room
2. Lock target room as active output in Sonos Web
3. Verify active output actually switched
4. Search content / narrow intent
5. Open the correct result detail page
6. Open `更多选项`
7. Choose playback action in the required priority order
8. Verify success with Sonos CLI

Do not reorder these steps.

---

## 4. Hard action-entry schema
The primary action entry is **not** the search-result direct play button.

The true action entry is:
- `aria-label="更多选项"`
- usually a button/dialog trigger

Only after opening that menu/dialog may the agent choose:
1. `替换当前歌单` / `替换播放列表` / `替换队列`
2. `添加到队列末尾`
3. `立即播放`

Do not use search-result direct `播放XXX` as the primary path unless no valid menu-driven path exists and the user accepts lower reliability.

---

## 5. Hard playback-action priority schema
When `更多选项` opens, use this priority order:
1. `替换当前歌单` / `替换播放列表` / `替换队列`
2. `添加到队列末尾`
3. `立即播放`

This priority is mandatory.

---

## 6. Hard success schema
A browser-side visual change is **not** success.

Success requires CLI confirmation.
Use:
- `sonos status --name "<room>"`
- `sonos queue list --name "<room>"`

Only claim success if CLI confirms the expected room/content change.

---

## 7. Playlist-vs-track schema
Playlist-level replacement usually starts playback from the **first track** of that playlist.

Therefore:
- if user intent is **theme / mood / artist mix**, playlist-level replace is acceptable
- if user intent is **an exact song**, do not stop at replacing a whole playlist unless the requested song is actually first
- for exact-song requests, target the specific track and verify the CLI current track matches that song

---

## 8. Search schema
### For exact song requests
Prefer explicit narrowing using:
- artist name
- song title
- service source if needed

### For broad mood/theme requests
Generate 3-5 short candidate queries and try them sequentially.

### Allowed source preference
Prefer:
1. 网易云音乐
2. QQ音乐 (allowed but less reliable)

### Reliability note
QQ音乐 may error at runtime. If QQ fails, prefer a stable 网易云 path instead of pretending the result is usable.

---

## 9. Verification gates
Do not continue to the next stage unless the current gate is satisfied:

### Gate A: Room lock
Must confirm target room is the active output context.

### Gate B: Detail page
Must confirm the correct detail page opened.
Signals include:
- title/header matches target content
- visible controls like `更多选项`, `播放`, `随机播放`

### Gate C: Action menu
Must confirm the `更多选项` dialog/menu is open and contains valid actions.

### Gate D: CLI truth
Must confirm playback/queue actually changed.

---

## 10. Forbidden shortcuts
Do not:
- search first before locking the room
- use stale snapshots after typing/searching
- treat a visible page reaction as success without CLI verification
- use `sonos next` to fake successful media replacement
- replace a playlist when the user explicitly requested one exact track unless that track is the actual playback result
- interpret PageController as merely a keyboard/input-method helper

---

## 11. What PageController is actually for
PageController is used for:
1. room/output targeting
2. fresh UI understanding after every state change
3. result filtering and semantic narrowing
4. detail-page confirmation
5. `更多选项` menu entry targeting
6. playback-action selection before CLI verification

Critical boundary:
- PageController is **browser-context only**.
- Plain Node runtime (without page context) is unsupported for MEDIA_FLOW.
- Do not claim MEDIA_FLOW success from Node logs alone.

Required upstream usage reference:
- https://alibaba.github.io/page-agent/docs/advanced/page-controller

Any agent modifying this skill must read that guide first.

---

## 12. Files
- `references/page-controller-sop.md` = operational SOP derived from this schema
- `scripts/page-agent-web-flow.mjs` = browser-side helper path
- `scripts/sonos-v25-run.sh` = execution entry
