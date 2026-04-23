import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildStepArtifactBasename,
  assertBrowserProfileSetup,
  inspectBrowserProfileSetup,
  isRetryableBrowserAttachError,
  normalizeStepGateResult,
  resolveBrowserHeadlessMode,
  summarizeBrowserAttachError,
} from './browser-runner.mjs';

test('normalizes step gate results into ok-shaped objects', () => {
  assert.deepEqual(normalizeStepGateResult(true), { ok: true });
  assert.deepEqual(normalizeStepGateResult(false), { ok: false });
  assert.deepEqual(normalizeStepGateResult({ ok: false, reason: 'bad' }), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeStepGateResult('value'), { ok: true, value: 'value' });
});

test('builds safe artifact basenames from step names', () => {
  const name = buildStepArtifactBasename('query gate / search', new Date('2026-04-23T04:00:00.000Z'));
  assert.match(name, /^2026-04-23T04-00-00-000Z-query-gate-search$/);
});

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
    inspectBrowserProfileSetup({ env: {}, configPath: tmpPath, runtimeProfiles: [] }),
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
      runtimeProfiles: [],
      runtimeProfileExists: false,
      runtimeProfile: null,
      profileExists: true,
      profileConfig: { driver: 'openclaw' },
    }
  );
});

test('fails fast when OpenClaw config is missing', () => {
  assert.throws(
    () => assertBrowserProfileSetup({ env: {}, configPath: '/path/that/does/not/exist.json', runtimeProfiles: [] }),
    /OpenClaw config is missing or unreadable/i
  );
});

test('fails fast when browser runtime is disabled', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { enabled: false, profiles: { openclaw: {} } } }), 'utf8');

  assert.throws(
    () => assertBrowserProfileSetup({ env: {}, configPath: tmpPath, runtimeProfiles: [] }),
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
    () => assertBrowserProfileSetup({ env: {}, configPath: tmpPath, profile: 'other-profile', runtimeProfiles: [] }),
    /Browser profile "other-profile" is not available/i
  );
});

test('accepts runtime-default openclaw profile even when not explicitly configured', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sonos-browser-runner-'));
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const tmpPath = path.join(tmpDir, 'openclaw.json');
  await fs.promises.writeFile(tmpPath, JSON.stringify({ browser: { enabled: true, profiles: {} } }), 'utf8');

  const setup = assertBrowserProfileSetup({
    env: {},
    configPath: tmpPath,
    profile: 'openclaw',
    runtimeProfiles: [{ name: 'openclaw', running: true }],
  });

  assert.equal(setup.profileExists, true);
  assert.equal(setup.runtimeProfileExists, true);
  assert.equal(setup.profileConfig, null);
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
