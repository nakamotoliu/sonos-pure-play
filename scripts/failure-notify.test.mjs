import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildFailureNotifyCaption,
  buildSuccessNotifyCaption,
  loadFailureNotifyConfig,
  saveSuccessScreenshot,
} from './failure-notify.mjs';

test('loads failure notify config from local file', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-failure-notify-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const configPath = path.join(tmpDir, 'failure-notify.local.json');
  await fs.promises.writeFile(configPath, JSON.stringify({ enabled: true, target: '123', accountId: 'default' }), 'utf8');

  const config = loadFailureNotifyConfig({ configPath, env: {} });
  assert.equal(config.enabled, true);
  assert.equal(config.target, '123');
  assert.equal(config.accountId, 'default');
  assert.equal(config.channel, 'telegram');
});

test('builds readable failure notify caption', () => {
  const caption = buildFailureNotifyCaption({
    capturedAt: '2026-04-23T04:42:47.364Z',
    step: 'query-gate',
    room: '客厅 play5',
    request: '播放 范晓萱热歌',
    query: '范晓萱热歌',
    targetId: 'abc',
    artifactPath: '/tmp/a.json',
    screenshotPath: '/tmp/a.png',
    error: { message: 'timeout' },
  });

  assert.match(caption, /Sonos 技能失败现场/);
  assert.match(caption, /步骤：query-gate/);
  assert.match(caption, /请求：播放 范晓萱热歌/);
  assert.match(caption, /截图：\/tmp\/a\.png/);
});

test('builds readable success notify caption', () => {
  const caption = buildSuccessNotifyCaption({
    capturedAt: '2026-04-23T04:53:22.188Z',
    room: '客厅 play5',
    request: '播放 范晓萱热歌',
    query: '范晓萱热歌',
    targetId: 'abc',
    screenshotPath: '/tmp/success.png',
    chosenCandidate: { title: '小魔女的魔法书' },
    playbackVerifyResult: { finalState: 'PLAYING' },
  });

  assert.match(caption, /Sonos 技能执行成功/);
  assert.match(caption, /选择结果：小魔女的魔法书/);
  assert.match(caption, /播放校验：PLAYING/);
});

test('saves success screenshot with timestamp filename', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-success-shot-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const sourcePath = path.join(tmpDir, 'source.png');
  await fs.promises.writeFile(sourcePath, 'png', 'utf8');

  const saved = saveSuccessScreenshot({
    sourcePath,
    capturedAt: new Date('2026-04-23T04:53:22.188Z'),
    artifactRoot: tmpDir,
  });

  assert.ok(saved);
  assert.match(path.basename(saved), /^2026-04-23T04-53-22-188Z-run-succeeded\.png$/);
  assert.equal(fs.existsSync(saved), true);
});
