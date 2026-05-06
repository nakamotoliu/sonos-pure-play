import test from 'node:test';
import assert from 'node:assert/strict';

import { detectNonTargetPlaybackLeaks, parseDiscoverRooms, parseStatus, selectRoomMatch } from './cli-control.mjs';

const rooms = ['主卧', '客厅 play5', '小房间', '工作室'];

test('fuzzy room matching maps partial Chinese room name to full Sonos room name', () => {
  const match = selectRoomMatch(rooms, '客厅');
  assert.equal(match.ok, true);
  assert.equal(match.room, '客厅 play5');
});

test('fuzzy room matching accepts exact full room name', () => {
  const match = selectRoomMatch(rooms, '客厅 play5');
  assert.equal(match.ok, true);
  assert.equal(match.room, '客厅 play5');
});

test('fuzzy room matching accepts compacted room spelling', () => {
  const match = selectRoomMatch(rooms, '客厅play5');
  assert.equal(match.ok, true);
  assert.equal(match.room, '客厅 play5');
});

test('fuzzy room matching refuses ambiguous partial names', () => {
  const match = selectRoomMatch(['客厅 play5', '客厅 Era 300'], '客厅');
  assert.equal(match.ok, false);
  assert.equal(match.reason, 'ambiguous');
  assert.deepEqual(match.candidates.map((item) => item.name).sort(), ['客厅 Era 300', '客厅 play5'].sort());
});

test('parseDiscoverRooms extracts room names from sonos discover output', () => {
  assert.deepEqual(parseDiscoverRooms('主卧\t192.168.50.40\tRINCON_x\n客厅 play5\t192.168.50.28\tRINCON_y\n'), ['主卧', '客厅 play5']);
});

test('parseStatus captures fields used by non-target playback guard', () => {
  const status = parseStatus('State:\t\tPLAYING\nTrack:\t\t8\nURI:\t\tx-sonos-http:abc\nTitle:\t\t那沙漠里的水\nArtist:\t\t方大同\nAlbum:\t\t梦想家 The Dreamer\nVolume:\t\t25');
  assert.equal(status.state, 'PLAYING');
  assert.equal(status.uri, 'x-sonos-http:abc');
  assert.equal(status.artist, '方大同');
  assert.equal(status.album, '梦想家 The Dreamer');
  assert.equal(status.volume, '25');
});

test('non-target guard ignores paused rooms and target room', () => {
  const leaks = detectNonTargetPlaybackLeaks({
    targetRoom: '客厅 play5',
    request: '方大同 精选',
    selectedContent: '梦想家 The Dreamer',
    before: [
      { room: '客厅 play5', status: { state: 'STOPPED' } },
      { room: '主卧', status: { state: 'PAUSED_PLAYBACK', title: 'Old' } },
    ],
    after: [
      { room: '客厅 play5', status: { state: 'PLAYING', title: 'XZMHXDXH', artist: '方大同', album: '梦想家 The Dreamer' } },
      { room: '主卧', status: { state: 'PAUSED_PLAYBACK', title: 'Old' } },
    ],
  });
  assert.deepEqual(leaks, []);
});

test('non-target guard flags a room that starts playing after playback action', () => {
  const leaks = detectNonTargetPlaybackLeaks({
    targetRoom: '客厅 play5',
    request: '方大同 精选',
    selectedContent: '梦想家 The Dreamer',
    before: [{ room: '主卧', status: { state: 'PAUSED_PLAYBACK', title: 'Old' } }],
    after: [{ room: '主卧', status: { state: 'PLAYING', title: 'XZMHXDXH', artist: '方大同', album: '梦想家 The Dreamer' } }],
  });
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].room, '主卧');
  assert.equal(leaks[0].reason, 'non-target-started-playing');
});

test('non-target guard allows pre-existing unchanged playback in another room', () => {
  const beforeStatus = { state: 'PLAYING', uri: 'x-old', title: 'Old Song', artist: 'Someone', album: 'Old Album', track: '1' };
  const leaks = detectNonTargetPlaybackLeaks({
    targetRoom: '客厅 play5',
    before: [{ room: '工作室', status: beforeStatus }],
    after: [{ room: '工作室', status: { ...beforeStatus } }],
  });
  assert.deepEqual(leaks, []);
});

test('non-target guard flags changed playback in another room', () => {
  const leaks = detectNonTargetPlaybackLeaks({
    targetRoom: '客厅 play5',
    before: [{ room: '工作室', status: { state: 'PLAYING', uri: 'x-old', title: 'Old Song', track: '1' } }],
    after: [{ room: '工作室', status: { state: 'PLAYING', uri: 'x-new', title: 'New Song', track: '1' } }],
  });
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].reason, 'non-target-playback-changed');
});
