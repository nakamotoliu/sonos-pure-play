import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySearchPageStateFromAriaSnapshot,
  extractUsablePageBlocksFromAriaSnapshot,
  shouldUseAriaSnapshotFallback,
} from './aria-snapshot-tools.mjs';

const historySnapshot = {
  url: 'https://play.sonos.com/zh-cn/search',
  nodes: [
    { ref: 'ax1', role: 'RootWebArea', name: 'Sonos', depth: 0 },
    { ref: 'ax26', role: 'combobox', name: '', depth: 7 },
    { ref: 'ax37', role: 'heading', name: '搜索', depth: 6 },
    { ref: 'ax42', role: 'heading', name: '搜索记录', depth: 8 },
    { ref: 'ax45', role: 'button', name: '清除', depth: 8 },
    { ref: 'ax51', role: 'button', name: '寓言', depth: 10 },
    { ref: 'ax61', role: 'image', name: 'QQ音乐', depth: 13 },
    { ref: 'ax63', role: 'StaticText', name: '专辑', depth: 14 },
    { ref: 'ax66', role: 'button', name: '舞会皇后', depth: 10 },
    { ref: 'ax81', role: 'heading', name: '您的服务', depth: 7 },
    { ref: 'ax84', role: 'link', name: '查看所有', depth: 7 },
    { ref: 'ax89', role: 'button', name: 'Sonos Radio', depth: 8 },
    { ref: 'ax92', role: 'button', name: 'QQ音乐', depth: 8 },
    { ref: 'ax95', role: 'button', name: '网易云音乐', depth: 8 },
    { ref: 'ax100', role: 'region', name: '系统视图', depth: 4 },
    { ref: 'ax107', role: 'button', name: '将工作室设置为有效', depth: 8 },
  ],
};

test('classifySearchPageStateFromAriaSnapshot treats history/service/system views as non-results', () => {
  const state = classifySearchPageStateFromAriaSnapshot(historySnapshot, { expectedQuery: '王菲热歌' });
  assert.equal(state.pageKind, 'SEARCH_HISTORY');
  assert.equal(state.resultsPresent, false);
  assert.equal(state.realtimeResultStructure, false);
  assert.equal(state.historyVisible, true);
  assert.deepEqual(state.serviceLabels, []);
});

test('extractUsablePageBlocksFromAriaSnapshot excludes search history buttons from candidates', () => {
  const surface = extractUsablePageBlocksFromAriaSnapshot(historySnapshot);
  assert.equal(surface.usableBlocks.candidates.length, 0);
  assert.deepEqual(
    [...surface.usableBlocks.serviceTabs.map((entry) => entry.text)].sort(),
    ['QQ音乐', '网易云音乐', 'Sonos Radio'].sort()
  );
});

test('shouldUseAriaSnapshotFallback recognizes unsupported Playwright evaluate failures', () => {
  assert.equal(
    shouldUseAriaSnapshotFallback({
      code: 'BROWSER_ATTACH_FAILED',
      message: "GatewayClientRequestError: Playwright is not available in this gateway build; 'act:evaluate' is unsupported.",
    }),
    true
  );
});
