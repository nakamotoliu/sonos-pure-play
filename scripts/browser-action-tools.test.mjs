import test from 'node:test';
import assert from 'node:assert/strict';

import { choosePlaybackAction, openPlaybackActionMenu } from './browser-action-tools.mjs';

function createFakeRunner({ evaluateResults = [] } = {}) {
  const state = {
    evaluateResults: [...evaluateResults],
    waits: [],
  };

  return {
    waitMs(ms) {
      state.waits.push(ms);
    },
    evaluate() {
      if (!state.evaluateResults.length) throw new Error('Unexpected evaluate call');
      return { result: state.evaluateResults.shift() };
    },
    get waits() {
      return state.waits;
    },
  };
}

test('openPlaybackActionMenu opens more options and confirms actions are visible', () => {
  const runner = createFakeRunner({
    evaluateResults: [
      {
        detailHeading: '雷鬼电音精选',
        detailHasMoreOptions: true,
        visibleMenuItems: [],
      },
      {
        ok: true,
        clicked: '更多选项',
        detailHeading: '雷鬼电音精选',
      },
      {
        detailHeading: '雷鬼电音精选',
        detailHasMoreOptions: true,
        visibleMenuItems: ['替换队列', '立即播放'],
      },
    ],
  });

  const result = openPlaybackActionMenu(runner, 'tab-1');
  assert.equal(result.ok, true);
  assert.equal(result.clickedMoreOptions, true);
  assert.deepEqual(result.availableActions, ['替换队列', '立即播放']);
  assert.deepEqual(runner.waits, [350]);
});

test('choosePlaybackAction accepts normalized replace queue variants', () => {
  const runner = createFakeRunner({
    evaluateResults: [
      {
        detailHeading: '雷鬼电音精选',
        detailHasMoreOptions: false,
        visibleMenuItems: ['替换播放列表', '立即播放'],
      },
      {
        ok: true,
        clicked: '替换播放列表',
      },
      {
        detailHeading: '雷鬼电音精选',
        detailHasMoreOptions: false,
        visibleMenuItems: [],
      },
    ],
  });

  const result = choosePlaybackAction(runner, 'tab-1', ['替换队列', '立即播放']);
  assert.equal(result.ok, true);
  assert.equal(result.actualLabel, '替换播放列表');
  assert.equal(result.normalizedAction, '替换队列');
  assert.deepEqual(runner.waits, [350]);
});

test('openPlaybackActionMenu fails when detail page has no more-options entry', () => {
  const runner = createFakeRunner({
    evaluateResults: [
      {
        detailHeading: '雷鬼电音精选',
        detailHasMoreOptions: false,
        visibleMenuItems: [],
      },
    ],
  });

  assert.throws(
    () => openPlaybackActionMenu(runner, 'tab-1'),
    /Could not find the detail-page 更多选项 entry/
  );
});
