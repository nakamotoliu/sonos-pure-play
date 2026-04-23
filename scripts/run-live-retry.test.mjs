import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidateAttemptPool,
  shouldRetryWithNextCandidate,
  shouldRetryWithNextQuery,
} from './run-live-retry.mjs';

test('buildCandidateAttemptPool prefers recommended candidates and deduplicates', () => {
  const pool = buildCandidateAttemptPool({
    usableBlocks: {
      candidates: [
        { title: 'A', type: 'playlist', playLabel: '播放A', recommended: false },
        { title: 'B', type: 'playlist', playLabel: '播放B', recommended: true },
        { title: 'B', type: 'playlist', playLabel: '播放B', recommended: true },
        { title: 'C', type: 'album', playLabel: '播放C', recommended: false },
      ],
    },
  }, { maxCandidates: 3 });

  assert.deepEqual(pool.map((entry) => entry.title), ['B', 'A', 'C']);
});

test('shouldRetryWithNextCandidate accepts playback and candidate-step failures', () => {
  assert.equal(shouldRetryWithNextCandidate({ phase: 'verify-cli', data: { retryable: true } }), true);
  assert.equal(shouldRetryWithNextCandidate({ code: 'PLAYBACK_MENU_OPEN_FAILED' }), true);
  assert.equal(shouldRetryWithNextCandidate({ data: { step: 'candidate-click' } }), true);
  assert.equal(shouldRetryWithNextCandidate({ code: 'ROOM_NOT_FOUND' }), false);
});

test('shouldRetryWithNextQuery accepts query-layer failures', () => {
  assert.equal(shouldRetryWithNextQuery({ code: 'QUERY_NOT_CONFIRMED' }), true);
  assert.equal(shouldRetryWithNextQuery({ code: 'BROWSER_ATTACH_FAILED', data: { step: 'navigate' } }), true);
  assert.equal(shouldRetryWithNextQuery({ code: 'PLAYBACK_ACTION_CLICK_FAILED' }), false);
});
