# Sonos Pure Play Agent Protocol

## Goal
Keep code-layer behavior deterministic and small. The skill defines the workflow. The agent follows that workflow and uses the available tools.

## Fixed business flow

The core media workflow is fixed and must not drift at runtime:

1. Resolve target room by Sonos CLI.
2. Normalize the target room to solo by Sonos CLI.
3. Capture preflight playback state by Sonos CLI.
4. Ensure the visible Sonos browser target.
5. Open the fixed Sonos search page.
6. Sync Sonos Web active output to the CLI-resolved room.
7. Write the search query and verify retention.
8. Read the search surface and extract usable page blocks.
9. Select one candidate.
10. Open the content surface and extract usable page blocks.
11. Open `更多选项` when available.
12. Perform the playback action.
13. Verify final success by Sonos CLI.

Runtime recovery is allowed only inside this fixed flow. Recovery can retry a step, reread a surface, or reload the fixed search page. Recovery must not invent a new business flow.

## Browser tools

- `browser-open-tools.mjs`
  - Find/focus the visible Sonos browser tab.
  - Open `https://play.sonos.com/zh-cn/search`.
  - Navigate and wait when needed.

- `browser-read-tools.mjs`
  - Read current URL/title.
  - Read menu items.
  - Read room sync state.
  - Take screenshots and snapshots.

- `browser-surface-tools.mjs`
  - Extract the blocks the agent can use directly:
    - `inputs`
    - `serviceTabs`
    - `candidates`
    - `clickables`
    - `menuActions`
    - `rows`

- `browser-action-tools.mjs`
  - Click visible buttons.
  - Click room activation controls.
  - Type, fill, press, and submit input actions.

- `search-input-ops.mjs`
  - Focus the visible search box.
  - Replace the query.
  - Verify the query stayed in the box.

## CLI primitives

- `resolveRoom(roomInput)`
- `ensureSoloRoom(room)`
- `getStatus(room)`
- `getQueueJson(room)`
- `applyControlSteps(room, steps)`

There is no required code-side orchestrator contract. The skill instructions define the step order, and the browser/CLI tools execute those steps.

## Success contract

The browser flow is only considered a candidate execution trace.

Final truth comes from Sonos CLI:
- room/group is correct
- playback state is `PLAYING`
- queue/title/track changed or matches the requested content

Page surfaces are debug evidence, not final truth.
