# Changelog

All notable changes to `sonos-pure-play` should be recorded here.

## 0.2.1 - 2026-03-15

### Fixed
- Completed the exported anti-repeat flow by including `scripts/playback-memory.mjs` in the publish repo.
- Updated exported `scripts/run.mjs` so playback history is loaded before selection and written only after CLI verification succeeds.
- Corrected README coverage so semantic intent decomposition and anti-repeat playback history are explicitly documented.
- Corrected release hygiene: this patch release exists because published content changed and therefore required a version bump.

### Verified
- Export completeness review now passes: documented anti-repeat capability is present in exported code and entry wiring.
- `node --check` passes for exported `scripts/run.mjs`, `scripts/playback-memory.mjs`, and `scripts/candidate-ranker.mjs`.

## 0.2.0 - 2026-03-15

### Added
- Added intent-aware candidate ranking so original request wording can influence result selection beyond coarse genre/mood matching.
- Added playback-history writeback after verified success so future ranking can penalize recently played content.
- Added `view all` / `show more` expansion flow for broader candidate recall on Sonos Web.
- Added zone-aware extraction to distinguish search results from system controls and now-playing UI.
- Added playback-history persistence and pre-selection penalty flow so repeated content can be de-prioritized before the next selection.

### Changed
- Upgraded search-result engagement from a single linear click path to a state machine that can try `open-detail`, `expand`, and `direct-play` paths.
- Strengthened detail-page detection to use multiple signals instead of trusting a single `更多选项` button.
- Improved query planning for short intents by generating additional recall candidates and intent-profile metadata.
- Improved candidate title derivation from button label + local scope text instead of trusting generic `播放` labels.

### Integration correction
- Export repo now includes `scripts/playback-memory.mjs` and the updated `scripts/run.mjs` wiring so the documented anti-repeat flow is actually present in the published package.

### Verified
- Real E2E run succeeded for a mood-style request equivalent to "play happy weekend folk in the living room, volume 0".
- Web flow reached actionable playback menu, chose `替换队列`, and CLI verification confirmed playback change.
- Post-play control step for volume `0` executed successfully after playback.

### Known limitations
- Detail-page detection is stronger but still not perfectly isolated from all noisy Sonos Web regions.
- Section/type inference from expanded result pages can still be imprecise.
- Query compression is improved but not yet at the ideal short-token quality for all mood/scene prompts.
