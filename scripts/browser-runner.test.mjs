import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isRetryableBrowserAttachError,
  resolveBrowserHeadlessMode,
  shouldUseTemporaryGlobalHeadlessConfig,
  summarizeBrowserAttachError,
} from './browser-runner.mjs';

test('marks gateway timeout as retryable', () => {
  assert.equal(
    isRetryableBrowserAttachError(
      'Error: gateway timeout after 20000ms\nGateway target: ws://127.0.0.1:18789\nSource: local loopback'
    ),
    true
  );
});

test('marks socket reset as retryable', () => {
  assert.equal(isRetryableBrowserAttachError('connect ECONNRESET 127.0.0.1:18789'), true);
});

test('does not mark auth/config failures as retryable', () => {
  assert.equal(isRetryableBrowserAttachError('gateway token missing'), false);
  assert.equal(isRetryableBrowserAttachError('unknown browser profile openclaw'), false);
});

test('adds a short attach summary for transient gateway failures', () => {
  assert.match(
    summarizeBrowserAttachError('gateway timeout after 20000ms'),
    /attach timed out|socket dropped/i
  );
});

test('prefers OPENCLAW_BROWSER_HEADLESS env override', () => {
  assert.equal(
    resolveBrowserHeadlessMode({
      env: { OPENCLAW_BROWSER_HEADLESS: 'true' },
      configPath: '/path/that/does/not/exist.json',
    }),
    true
  );
  assert.equal(
    resolveBrowserHeadlessMode({
      env: { OPENCLAW_BROWSER_HEADLESS: '0' },
      configPath: '/path/that/does/not/exist.json',
    }),
    false
  );
});

test('falls back to browser.headless in OpenClaw config', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { headless: true } }), 'utf8');
  assert.equal(resolveBrowserHeadlessMode({ env: {}, configPath: tmpPath }), true);
});

test('prefers browser.profiles.<name>.headless over global browser.headless', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify({
      browser: {
        headless: false,
        profiles: {
          'openclaw-headless': { headless: true },
        },
      },
    }),
    'utf8'
  );
  assert.equal(resolveBrowserHeadlessMode({ env: {}, configPath: tmpPath }), true);
  assert.equal(
    shouldUseTemporaryGlobalHeadlessConfig({ env: {}, configPath: tmpPath }),
    false
  );
});

test('uses temporary global headless fallback only for the legacy dedicated profile convention', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { headless: false } }), 'utf8');
  assert.equal(
    shouldUseTemporaryGlobalHeadlessConfig({
      env: {},
      configPath: tmpPath,
      profile: 'openclaw-headless',
    }),
    true
  );
});
