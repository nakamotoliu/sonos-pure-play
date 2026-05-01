import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRoomActiveState } from './room-active-detector.mjs';

test('active room is confirmed from selected sidebar room card, not CLI or bottom playback state', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 王菲 寓言 音量 静音',
    labels: ['输出选择器', '播放群组客厅 play5', '暂停群组客厅 play5'],
    selected: true,
  });

  assert.equal(state.activeRoomConfirmed, true);
  assert.equal(state.reason, 'sidebar-selected-room-card');
  assert.deepEqual(state.activeControls, ['输出选择器', '播放群组客厅 play5', '暂停群组客厅 play5']);
});

test('active room card is the specific selected card without a set-active option, not the outer system wrapper', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 Alone at the Beach Alone at the Beach Rafael Manso 25',
    labels: ['输出选择器', '暂停群组客厅 play5', '静音'],
    selected: true,
  });

  assert.equal(state.hasActivate, false);
  assert.equal(state.activeRoomConfirmed, true);
  assert.equal(state.reason, 'sidebar-selected-room-card');
});

test('outer activation wrapper is not a second room card', () => {
  const inner = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 Alone at the Beach Alone at the Beach Rafael Manso 25',
    labels: ['输出选择器', '暂停群组客厅 play5', '静音'],
    selected: true,
  });
  const outer = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 Alone at the Beach Alone at the Beach Rafael Manso 25',
    labels: ['将客厅 play5设置为有效', '输出选择器', '暂停群组客厅 play5', '静音'],
  });

  assert.equal(inner.activeRoomConfirmed, true);
  assert.equal(outer.activeRoomConfirmed, false);
  assert.equal(outer.reason, 'page-offers-set-active');
});

test('room card without set-active is not active when CLI says that room is stopped', () => {
  const state = classifyRoomActiveState({
    room: '主卧',
    text: '主卧 海底世界 I 莫扎特D大调第三乐章 桂圆妈妈 0',
    labels: ['输出选择器', '播放群组主卧', '静音'],
    nowPlayingText: '客厅 play5 Late in the Afternoon Jona Kandaly • SQ',
    cliState: 'STOPPED',
  });

  assert.equal(state.activeRoomConfirmed, false);
  assert.equal(state.reason, 'cli-room-stopped');
});

test('room card with set-active button is not active even if CLI might be playing', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 王菲 寓言 音量 静音',
    labels: ['将客厅 play5设置为有效', '播放群组客厅 play5'],
  });

  assert.equal(state.activeRoomConfirmed, false);
  assert.equal(state.reason, 'page-offers-set-active');
});

test('output selector without target room mention is not enough', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '主卧 You Are My Sunshine 音量 静音',
    labels: ['输出选择器', '播放群组主卧'],
  });

  assert.equal(state.activeRoomConfirmed, false);
  assert.equal(state.reason, 'mixed-room-card-not-valid');
});

test('plain card text is not active-room proof without page controls', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 王菲 寓言',
    labels: [],
  });

  assert.equal(state.activeRoomConfirmed, false);
});

test('now playing region naming the room is not active-room proof by itself', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 王菲 寓言',
    labels: ['将客厅 play5设置为有效', '输出选择器', '暂停群组客厅 play5'],
    nowPlayingText: '客厅 play5 新房客 QQ音乐 王菲 • SQ',
  });

  assert.equal(state.activeRoomConfirmed, false);
  assert.equal(state.reason, 'page-offers-set-active');
});

test('pressed sidebar group control confirms active room when no set-active button is present', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '客厅 play5 王菲 寓言 音量 静音',
    labels: ['输出选择器', '暂停群组客厅 play5'],
    pressedLabels: ['暂停群组客厅 play5'],
  });

  assert.equal(state.activeRoomConfirmed, true);
  assert.equal(state.reason, 'sidebar-pressed-room-control');
});

test('whole system list with multiple room controls is not a valid active-room card', () => {
  const state = classifyRoomActiveState({
    room: '客厅 play5',
    text: '工作室 客厅 play5 小房间 主卧',
    labels: [
      '将工作室设置为有效',
      '输出选择器',
      '播放群组工作室',
      '将客厅 play5设置为有效',
      '输出选择器',
      '暂停群组客厅 play5',
      '将主卧设置为有效',
      '输出选择器',
      '暂停群组主卧',
    ],
  });

  assert.equal(state.activeRoomConfirmed, false);
  assert.equal(state.reason, 'mixed-room-card-not-valid');
  assert.equal(state.mixedRoomCard, true);
});
