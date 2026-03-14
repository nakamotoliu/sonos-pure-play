# Sonos Pure Play Migration Map

Goal:
- keep proven Sonos playback business rules
- use OpenClaw browser runtime as the only web execution path
- keep Sonos CLI as the source of truth for room state and playback verification

## Reused logic

- `MEDIA_FLOW` vs `CONTROL_ONLY` split
- CLI-first room handling
- grouped-room normalization before playback
- query candidate planning for artist / playlist / mood-like requests
- `更多选项` as the action entry
- action priority: `替换队列` first, otherwise `立即播放`
- CLI truth verification after browser action

## Current phase-1 implementation

1. Resolve the exact target room via Sonos CLI.
2. Normalize the target room to solo if it is grouped.
3. Attach to an OpenClaw browser runtime and ensure a Sonos tab exists.
4. Build a short ordered search query plan from user intent.
5. Recover Sonos Web into a usable search state.
6. Sync the Sonos Web active output toward the CLI-resolved target room.
7. Execute search via focus + clipboard + paste.
8. Filter out room/group/transport noise from search results.
9. Open the first acceptable real result.
10. Open `更多选项` and choose `替换队列` or `立即播放`.
11. Verify success using Sonos CLI truth.

## Intentionally excluded

- relay-specific browser attach assumptions
- stale ref-click retry loops as the default path
- secondary web execution paths
- local development notes and machine-specific validation logs
