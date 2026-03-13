# PageController-Powered Web Playback SOP (V3.0 Schema-First)

This SOP implements the schema in `SKILL.md`.

## 1. Mode selection
### MEDIA_FLOW
Use only when PageController is available.

Preflight (required):
- `OPENCLAW_GATEWAY_TOKEN` exists
- `OPENCLAW_GATEWAY_URL` exists or uses default `http://127.0.0.1:18789`
- Gateway endpoint `chatCompletions` is enabled
- Browser is OpenClaw-managed (no Browser Relay required)

### CONTROL_ONLY
Use CLI only.

---

## 2. MEDIA_FLOW mandatory sequence
1. Resolve exact room name
2. Lock target room in Sonos Web
3. Verify active output switched
4. Search / narrow content
5. Open correct detail page
6. Open `更多选项`
7. Choose action by required priority
8. Verify with CLI

Do not skip steps.

---

## 3. Room lock gate
Before any search/content action:
- click `将<房间>设置为有效`
- take a fresh snapshot
- verify target room is the active output context

If room lock is not confirmed, stop and retry.

---

## 4. Search gate
### Exact-song intent
Narrow aggressively with artist + title.
Example:
- `王力宏 爱的就是你`

### Broad intent
Generate 3-5 short candidates.
Example:
- 开心 / 欢快 / 元气 / 快乐 / 活力

After every search input:
1. clear old text
2. type new query
3. wait briefly
4. take a fresh snapshot
5. decide using the fresh snapshot only

---

## 5. Result filtering
Prefer:
- 网易云音乐
- QQ音乐 (fallback / less reliable)

Prefer result types:
- 播放列表 / 歌单
- 专辑
- 明确匹配的单曲

Avoid:
- Sonos Radio / TuneIn / Radio / 直播
- weak semantic matches
- ambiguous results when user intent is exact

---

## 6. Detail-page gate
After selecting a result, verify the correct detail page is open.
Useful signals:
- header/title matches expected content
- visible `更多选项`
- visible `播放` / `随机播放`

If detail page is not confirmed, do not continue.

---

## 7. Action-entry gate
The true action entry is the `更多选项` button/dialog trigger.

Expected shape:
- `aria-label="更多选项"`
- dialog/menu opens after click

Do not treat search-result direct `播放XXX` as the main path.

---

## 8. Playback-action priority
Once the `更多选项` dialog/menu is open, use this order:
1. `替换当前歌单` / `替换播放列表` / `替换队列`
2. `添加到队列末尾`
3. `立即播放`

If none exist, report failure honestly.

---

## 9. Playlist-vs-track handling
If using playlist-level replace, expect playback to start from the playlist's first track.

So:
- artist/theme requests -> playlist replace is acceptable
- exact-song requests -> target the specific track and verify current track matches

---

## 10. CLI truth gate
Always verify with Sonos CLI:
- `sonos status --name "<room>"`
- `sonos queue list --name "<room>"`

Success means the CLI state matches the requested intent.

Page reaction alone is never sufficient.

---

## 11. Known failure classes
1. QQ music service error
2. broad query mis-hit
3. detail page not actually opened
4. menu action clicked but Sonos state unchanged

When any of these happen, report the real failed gate instead of claiming partial success.
