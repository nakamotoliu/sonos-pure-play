import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPlaybackHistory, recordPlaybackSelection } from './playback-memory.mjs';

test('records selection even when verify is not success', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonos-history-'));
  const historyPath = path.join(tempDir, 'history.json');
  process.env.SONOS_PLAYBACK_HISTORY_PATH = historyPath;

  try {
    const entry = recordPlaybackSelection({
      room: '客厅 play5',
      originalIntent: '雷鬼电音',
      queryUsed: '雷鬼电音',
      selectedTitle: 'Reggae EDM',
      selectedType: 'playlist',
      actionName: '替换队列',
      finalTitle: '',
      finalTrack: '',
      verify: 'copyright-blocked',
    });

    assert.equal(entry.selectedTitle, 'Reggae EDM');
    assert.equal(entry.verify, 'copyright-blocked');

    const history = loadPlaybackHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].selectedType, 'playlist');
    assert.equal(history[0].verify, 'copyright-blocked');
  } finally {
    delete process.env.SONOS_PLAYBACK_HISTORY_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
