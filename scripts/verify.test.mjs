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

test('marks copyright-unavailable not-playing verification failure as retryable', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '客厅 play5', state: 'PAUSED', title: 'old', track: 'old' },
      followupStatus: {
        group: '客厅 play5',
        state: 'STOPPED',
        title: '玫瑰（翻自 贰佰）',
        artist: '一色Ese 应版权方要求暂不能播放，QQ音乐正在争取中',
        album: '民谣周末',
        track: '1',
      },
      followupQueueJson: {
        items: [
          {
            position: 1,
            item: {
              title: '玫瑰（翻自 贰佰）',
              artist: '一色Ese 应版权方要求暂不能播放，QQ音乐正在争取中',
              album: '民谣周末',
            },
          },
        ],
      },
      selectedContent: '民谣周末',
      originalIntent: '周末慵懒民谣',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), true);
      assert.equal(error.data.retryReason, 'copyright-unavailable');
      assert.equal(error.data.unavailableEvidence.unavailableQueueItems[0].title, '玫瑰（翻自 贰佰）');
      return true;
    }
  );
});

test('still retries copyright-unavailable when retryPlay itself fails', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '客厅 play5', state: 'PAUSED', title: 'old', track: 'old' },
      followupStatus: {
        group: '客厅 play5',
        state: 'STOPPED',
        title: 'オープニング~軍雄割拠',
        artist: '横山菁児 应版权方要求暂不能播放，QQ音乐正在争取中',
        album: '三国志・第二部~長江燃ゆ!',
        track: '1',
      },
      followupQueueJson: { items: [] },
      retryPlay: () => {
        const error = new Error('upnp error 701');
        error.phase = 'control';
        error.code = 'SONOS_PLAY_FAILED';
        throw error;
      },
      retrySnapshot: () => ({
        status: {
          group: '客厅 play5',
          state: 'STOPPED',
          title: 'オープニング~軍雄割拠',
          artist: '横山菁児 应版权方要求暂不能播放，QQ音乐正在争取中',
          album: '三国志・第二部~長江燃ゆ!',
          track: '1',
        },
        queueJson: { items: [] },
      }),
      selectedContent: '三国志・第二部~長江燃ゆ!',
      originalIntent: '日漫燃曲',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), true);
      assert.equal(error.data.retryReason, 'copyright-unavailable');
      assert.equal(error.data.retryPlayError.code, 'SONOS_PLAY_FAILED');
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

test('marks playing content mismatch with track change as retryable', () => {
  assert.throws(
    () => verifyMediaPlayback({
      room: '客厅 play5',
      actionName: '替换队列',
      postStatus: { group: '客厅 play5', state: 'PLAYING', title: '寒武纪', track: '1' },
      followupStatus: { group: '客厅 play5', state: 'PLAYING', title: '笑忘书', track: '10' },
      followupQueueJson: { items: [{ id: 1 }] },
      selectedContent: '复古爵士欢快',
      originalIntent: '欢快周末爵士',
    }),
    (error) => {
      assert.equal(error.code, 'CLI_VERIFY_FAILED');
      assert.equal(isRetryablePlaybackVerificationFailure(error), true);
      assert.equal(error.data.retryReason, 'playing-content-mismatch');
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
