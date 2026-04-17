import test from 'node:test';
import assert from 'node:assert/strict';

import { assessQueryGateState } from './search-input-ops.mjs';

test('query gate passes when search page is ready and queryApplied is true', () => {
  const result = assessQueryGateState(
    {
      searchPageReady: true,
      queryApplied: true,
      pageKind: 'SEARCH_READY',
      searchValue: '张信哲热歌',
      historyVisible: true,
      visibleSearchBoxCount: 1,
    },
    '张信哲热歌'
  );

  assert.equal(result.ok, true);
  assert.equal(result.queryApplied, true);
});

test('query gate fails when query is missing from the visible input', () => {
  const result = assessQueryGateState(
    {
      searchPageReady: true,
      queryApplied: false,
      pageKind: 'SEARCH_HISTORY',
      searchValue: '',
      historyVisible: true,
      visibleSearchBoxCount: 1,
    },
    '张信哲热歌'
  );

  assert.equal(result.ok, false);
  assert.equal(result.queryApplied, false);
  assert.equal(result.pageKind, 'SEARCH_HISTORY');
});

test('query gate accepts exact normalized input match even if queryApplied flag is absent', () => {
  const result = assessQueryGateState(
    {
      searchPageReady: true,
      pageKind: 'SEARCH_READY',
      searchValue: '  张信哲   热歌 ',
      visibleSearchBoxCount: 1,
    },
    '张信哲 热歌'
  );

  assert.equal(result.ok, true);
  assert.equal(result.queryApplied, true);
});
