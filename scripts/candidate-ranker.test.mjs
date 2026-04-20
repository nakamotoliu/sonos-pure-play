import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates } from './candidate-ranker.mjs';

test('playlist-first selects an unplayed playlist before a played playlist', () => {
  const result = rankCandidates({
    originalIntent: '雷鬼电音',
    query: '雷鬼电音',
    requestKind: 'generic',
    strategy: 'playlist-first',
    allowedTypes: ['playlist'],
    resultGroups: {
      playlist: [
        { type: 'playlist', title: '雷鬼电音热歌单' },
        { type: 'playlist', title: '雷鬼电音精选' },
      ],
    },
    playbackHistory: [
      {
        ts: new Date().toISOString(),
        selectedTitle: '雷鬼电音热歌单',
        selectedType: 'playlist',
        queryUsed: '雷鬼电音',
      },
    ],
  });

  assert.equal(result.selected?.title, '雷鬼电音精选');
  assert.equal(result.ranked[0]?.title, '雷鬼电音精选');
  assert.equal(result.ranked[1]?.title, '雷鬼电音热歌单');
});

test('playlist-first falls back to score ordering when all visible playlists were played', () => {
  const now = new Date().toISOString();
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

  const result = rankCandidates({
    originalIntent: '雷鬼电音',
    query: '雷鬼电音',
    requestKind: 'generic',
    strategy: 'playlist-first',
    allowedTypes: ['playlist'],
    resultGroups: {
      playlist: [
        { type: 'playlist', title: '雷鬼电音热歌单' },
        { type: 'playlist', title: '雷鬼电音精选' },
      ],
    },
    playbackHistory: [
      { ts: oneDayAgo, selectedTitle: '雷鬼电音热歌单', selectedType: 'playlist', queryUsed: '雷鬼电音' },
      { ts: fourDaysAgo, selectedTitle: '雷鬼电音精选', selectedType: 'playlist', queryUsed: '雷鬼电音' },
    ],
    now,
  });

  assert.equal(result.selected?.title, '雷鬼电音精选');
  assert.equal(result.ranked[0]?.title, '雷鬼电音精选');
  assert.equal(result.ranked[1]?.title, '雷鬼电音热歌单');
});
