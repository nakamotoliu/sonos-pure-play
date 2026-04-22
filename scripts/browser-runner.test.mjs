import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertBrowserProfileSetup,
  inspectBrowserProfileSetup,
  isRetryableBrowserAttachError,
  resolveBrowserHeadlessMode,
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

test('reads configured browser profile setup details', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify({
      browser: {
        enabled: true,
        profiles: {
          openclaw: { driver: 'openclaw' },
        },
      },
    }),
    'utf8'
  );

  assert.deepEqual(
    inspectBrowserProfileSetup({ env: {}, configPath: tmpPath }),
    {
      profile: 'openclaw',
      configPath: tmpPath,
      config: {
        browser: {
          enabled: true,
          profiles: {
            openclaw: { driver: 'openclaw' },
          },
        },
      },
      configExists: true,
      browserEnabled: true,
      profileExists: true,
      profileConfig: { driver: 'openclaw' },
    }
  );
});

test('fails fast when OpenClaw config is missing', () => {
  assert.throws(
    () => assertBrowserProfileSetup({ env: {}, configPath: '/path/that/does/not/exist.json' }),
    /OpenClaw config is missing or unreadable/i
  );
});

test('fails fast when browser runtime is disabled', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { enabled: false, profiles: { openclaw: {} } } }), 'utf8');

  assert.throws(
    () => assertBrowserProfileSetup({ env: {}, configPath: tmpPath }),
    /browser runtime is disabled/i
  );
});

test('fails fast when the selected browser profile is not configured', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify({
      browser: {
        enabled: true,
        profiles: {
          openclaw: { headless: false },
        },
      },
    }),
    'utf8'
  );

  assert.throws(
    () => assertBrowserProfileSetup({ env: {}, configPath: tmpPath, profile: 'other-profile' }),
    /Browser profile "other-profile" is not configured/i
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
          openclaw: { headless: true },
        },
      },
    }),
    'utf8'
  );
  assert.equal(resolveBrowserHeadlessMode({ env: {}, configPath: tmpPath }), true);
});

test('default openclaw profile is not implicitly forced to headless', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { headless: false, profiles: { openclaw: {} } } }), 'utf8');
  assert.equal(
    resolveBrowserHeadlessMode({
      env: {},
      configPath: tmpPath,
      profile: 'openclaw',
    }),
    false
  );
});
