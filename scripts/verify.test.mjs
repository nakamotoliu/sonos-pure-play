import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryablePlaybackVerificationFailure,
  MAX_PLAYBACK_ATTEMPTS,
  verifyMediaPlayback,
} from './verify.mjs';

test('exports playback retry budget of 3', () => {
  assert.equal(MAX_PLAYBACK_ATTEMPTS, 3);
});

test('marks not-playing verification failure as retryable', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '客厅 play5', state: 'PAUSED', title: 'old', track: 'old' },
      followupStatus: { group: '客厅 play5', state: 'TRANSITIONING', title: 'old', track: 'old' },
      followupQueueJson: { items: [] },
      selectedContent: 'Reggae EDM',
      originalIntent: '雷鬼电音',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), true);
      assert.equal(error.data.retryReason, 'not-playing-after-action');
      return true;
    }
  );
});

test('marks playing-without-content-match verification failure as retryable', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '客厅 play5', state: 'PLAYING', title: 'old', track: 'old' },
      followupStatus: { group: '客厅 play5', state: 'PLAYING', title: 'old', track: 'old' },
      followupQueueJson: { items: [] },
      selectedContent: 'Reggae EDM',
      originalIntent: '雷鬼电音',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), true);
      assert.equal(error.data.retryReason, 'playing-without-content-match');
      return true;
    }
  );
});

test('marks group mismatch as non-retryable verification failure', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '主卧', state: 'PLAYING', title: 'old', track: 'old' },
      followupStatus: { group: '主卧', state: 'PLAYING', title: 'new', track: 'new' },
      followupQueueJson: { items: [{ id: 1 }] },
      selectedContent: 'Reggae EDM',
      originalIntent: '雷鬼电音',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), false);
      assert.equal(error.data.retryReason, 'group-mismatch');
      return true;
    }
  );
});
