import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSelectionDecisionReport, enrichUsablePageBlocks } from './browser-surface-tools.mjs';

test('enriched candidates expose scores and recommend a fresh playlist first', () => {
  const enriched = enrichUsablePageBlocks({
    usableBlocks: {
      candidates: [
        { title: '雷鬼电音热歌单', playLabel: '播放雷鬼电音热歌单', canClick: true },
        { title: '雷鬼电音精选', playLabel: '播放雷鬼电音精选', canClick: true },
      ],
    },
    originalIntent: '雷鬼电音',
    query: '雷鬼电音',
    requestKind: 'generic',
    strategy: 'playlist-first',
    allowedTypes: ['playlist'],
    playbackHistory: [
      {
        ts: new Date().toISOString(),
        selectedTitle: '雷鬼电音热歌单',
        selectedType: 'playlist',
        queryUsed: '雷鬼电音',
      },
    ],
  });

  assert.equal(enriched.candidates[0].title, '雷鬼电音精选');
  assert.equal(enriched.candidates[0].recommended, true);
  assert.equal(enriched.candidates[0].recommendedReason, 'fresh-playlist');
  assert.equal(enriched.candidates[0].scoreKind, 'history-aware-ordering');
  assert.equal(enriched.candidates[0].alreadySelectedBefore, false);
  assert.equal(enriched.selectionSummary.topRecommended.title, '雷鬼电音精选');
  assert.equal(enriched.selectionSummary.topRecommended.finalScore, enriched.candidates[0].finalScore);

  assert.equal(enriched.candidates[1].title, '雷鬼电音热歌单');
  assert.equal(enriched.candidates[1].alreadySelectedBefore, true);
  assert.equal(enriched.candidates[1].recommendedReason, 'played-before');
  assert.ok(enriched.candidates[1].historyPenalty < 0);
});

test('builds a decision report comparing recommendation and final choice', () => {
  const enriched = enrichUsablePageBlocks({
    usableBlocks: {
      candidates: [
        { title: '雷鬼电音热歌单', playLabel: '播放雷鬼电音热歌单', canClick: true },
        { title: '雷鬼电音精选', playLabel: '播放雷鬼电音精选', canClick: true },
      ],
    },
    originalIntent: '雷鬼电音',
    query: '雷鬼电音',
    requestKind: 'generic',
    strategy: 'playlist-first',
    allowedTypes: ['playlist'],
    playbackHistory: [
      {
        ts: new Date().toISOString(),
        selectedTitle: '雷鬼电音热歌单',
        selectedType: 'playlist',
        queryUsed: '雷鬼电音',
      },
    ],
  });

  const report = buildSelectionDecisionReport({
    usableBlocks: enriched,
    chosenTitle: '雷鬼电音热歌单',
    chosenType: 'playlist',
    decisionReason: 'top candidate was not clickable',
  });

  assert.equal(report.topRecommended.title, '雷鬼电音精选');
  assert.equal(report.chosen.title, '雷鬼电音热歌单');
  assert.equal(report.chosen.scoreKind, 'history-aware-ordering');
  assert.equal(report.deviation, true);
  assert.equal(report.decisionReason, 'top candidate was not clickable');
});

test('playlist mood requests always expose a fallback recommendation when results exist', () => {
  const enriched = enrichUsablePageBlocks({
    usableBlocks: {
      candidates: [
        { title: '复古爵士欢快', playLabel: '播放复古爵士欢快', canClick: true },
        { title: '高级 欢快 爵士', playLabel: '播放高级 欢快 爵士', canClick: true },
      ],
    },
    originalIntent: '欢快周末爵士',
    query: '欢快周末爵士',
    requestKind: 'playlist',
    strategy: 'playlist-first',
    allowedTypes: ['playlist'],
    playbackHistory: [],
  });

  assert.ok(enriched.selectionSummary.selectedByRanker);
  assert.ok(enriched.selectionSummary.topRecommended);
  assert.equal(enriched.candidates[0].recommended, true);
  assert.equal(enriched.candidates[0].recommendedReason, 'fallback-playable-candidate');
  assert.ok(enriched.candidates[0].playLabel);
});
