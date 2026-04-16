## 2026-03-16 实施记录（Codex）
- 已在 `sonos-pure-play/scripts` 落地新的页面判定：`SEARCH_HISTORY` / `SEARCH_SHELL_DIRTY` / `SEARCH_RESULTS_MIXED` / `SEARCH_RESULTS_PLAYLISTS` / `PLAYLIST_DETAIL_READY`，并补充 `CONTENT_DETAIL_READY` 作为非歌单详情兜底。
- playlist-first 流程改成显式分阶段：先锁定播放列表 section → scoped view-all → playlist-only 结果池 → 详情页 → 顶层菜单 → 行为执行。
- 顶层 `更多选项` 仅从歌单详情页动作区抓取，不再允许行级菜单误点。
- 新增 staged retry：读页轻重试、view-all 点击重试、详情页进入重试、菜单打开重试；只有阶段失败才回退 query rotation。
- 选歌单时加入“候选池耗尽才重置”的历史语义；未耗尽前强制避开已播歌单，并保留近期播放惩罚。
- 修复候选抽取层对弱容器结果的遗漏：当 Sonos 搜索结果只暴露 item-level `播放<标题>` 控件、但 `containerIndex=-1` / `sectionKind=unknown` 时，改为用标题与行文本生成 synthetic candidate grouping，并从 row text 回推 `playlist` section kind。
- 保留原有 room/system 噪音过滤，但调整为“只有缺少媒体身份信号时才视为噪音”，避免真实 playlist row 因 footer/room 文本污染被误过滤成 `NO_PLAYLIST_CANDIDATE`。
