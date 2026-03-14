# Sonos Pure Play UI States

This skill treats Sonos Web as a state machine instead of a blind click script.

## States

- `APP_HOME`
  - Sonos Web is open but not yet in search.
- `SEARCH_READY`
  - Search page is open and ready for a new query.
- `SEARCH_LIVE`
  - Search page shows real results or search history after input.
- `SEARCH_DEAD`
  - Input changed but the page did not render results or history.
- `DETAIL_PAGE`
  - Detail page is open and `更多选项` is visible.
- `MORE_MENU_OPEN`
  - The action menu is open and readable.
- `ACTION_DONE`
  - One playback action was clicked.
- `UNKNOWN`
  - Page state cannot be classified safely.

## Transition rules

1. `APP_HOME -> SEARCH_READY`
   - Navigate to `/zh-cn/search`.
2. `SEARCH_READY -> SEARCH_READY`
   - Sync the active output toward the CLI-resolved target room.
3. `SEARCH_READY -> SEARCH_LIVE`
   - Focus the real search input and use clipboard paste.
4. `SEARCH_READY -> SEARCH_DEAD`
   - Input changed but Sonos did not render results/history.
5. `SEARCH_DEAD -> SEARCH_READY`
   - Re-enter search and retry once.
6. `SEARCH_LIVE -> SEARCH_READY`
   - If the real result region is empty or only noise, rotate to the next planned query.
7. `SEARCH_LIVE -> DETAIL_PAGE`
   - Click the first acceptable real result item.
8. `DETAIL_PAGE -> MORE_MENU_OPEN`
   - Click `更多选项`.
9. `MORE_MENU_OPEN -> ACTION_DONE`
   - Click `替换队列` first, otherwise `立即播放`.
