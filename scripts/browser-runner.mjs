/**
 * browser-runner.mjs — Browser automation for Sonos Pure Play.
 *
 * Uses the official `openclaw browser` CLI/runtime instead of a custom CDP
 * bridge. Browser CLI calls must use `--browser-profile`, never CLI root
 * `--profile`, because root profile switches the OpenClaw state directory.
 * API surface is kept compatible for the remaining browser tool consumers.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillError } from './normalize.mjs';
import { SEARCH_URL } from './selectors.mjs';
import {
  close as closeTool,
  ensureSonosTab as ensureSonosTabTool,
  focus as focusTool,
  navigate as navigateTool,
  start as startTool,
  tabs as tabsTool,
  waitForLoad as waitForLoadTool,
  waitMs as waitMsTool,
} from './browser-open-tools.mjs';
import {
  click as clickTool,
  clickButtonByLabel as clickButtonByLabelTool,
  clickRoomActivate as clickRoomActivateTool,
  choosePlaybackAction as choosePlaybackActionTool,
  fillRef as fillRefTool,
  openPlaybackActionMenu as openPlaybackActionMenuTool,
  press as pressTool,
  type as typeTool,
  typeRef as typeRefTool,
} from './browser-action-tools.mjs';
import {
  evaluate as evaluateTool,
  readPageState as readPageStateTool,
  readRoomContext as readRoomContextTool,
  readRoomSyncState as readRoomSyncStateTool,
  readVisibleMenuItems as readVisibleMenuItemsTool,
  screenshotRoot as screenshotRootTool,
  snapshot as snapshotTool,
  snapshotAi as snapshotAiTool,
} from './browser-read-tools.mjs';
import { extractUsablePageBlocks as extractUsablePageBlocksTool } from './browser-surface-tools.mjs';

const DEFAULT_GATEWAY_PORT = '18789';
const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_SONOS_BROWSER_PROFILE = 'openclaw';
const LOGIN_RECOVERY_SENTINEL = '__SONOS_LOGIN_RECOVERY_ACTIVE__';

function readOpenClawConfig(configPath = DEFAULT_OPENCLAW_CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

export function inspectBrowserProfileSetup({
  env = process.env,
  configPath = DEFAULT_OPENCLAW_CONFIG_PATH,
  profile = env.OPENCLAW_BROWSER_PROFILE || DEFAULT_SONOS_BROWSER_PROFILE,
} = {}) {
  const config = readOpenClawConfig(configPath);
  const configuredProfile = config?.browser?.profiles?.[profile] || null;

  return {
    profile,
    configPath,
    config,
    configExists: !!config,
    browserEnabled: config?.browser?.enabled !== false,
    profileExists: !!configuredProfile,
    profileConfig: configuredProfile,
  };
}

export function assertBrowserProfileSetup(options = {}) {
  const setup = inspectBrowserProfileSetup(options);

  if (!setup.configExists) {
    throw new SkillError(
      'preflight',
      'OPENCLAW_CONFIG_NOT_FOUND',
      `OpenClaw config is missing or unreadable at ${setup.configPath}. Create browser.profiles.${setup.profile} before running this Sonos skill.`,
      {
        profile: setup.profile,
        configPath: setup.configPath,
      }
    );
  }

  if (!setup.browserEnabled) {
    throw new SkillError(
      'preflight',
      'OPENCLAW_BROWSER_DISABLED',
      'OpenClaw browser runtime is disabled in config. Enable browser support before running this Sonos skill.',
      {
        profile: setup.profile,
        configPath: setup.configPath,
      }
    );
  }

  if (!setup.profileExists) {
    throw new SkillError(
      'preflight',
      'BROWSER_PROFILE_NOT_CONFIGURED',
      `Browser profile "${setup.profile}" is not configured in ${setup.configPath}. Create browser.profiles.${setup.profile} before running this Sonos skill.`,
      {
        profile: setup.profile,
        configPath: setup.configPath,
      }
    );
  }

  return setup;
}

function parseBooleanFlag(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function readGatewayPort() {
  if (process.env.OPENCLAW_GATEWAY_PORT) return String(process.env.OPENCLAW_GATEWAY_PORT);
  try {
    const config = readOpenClawConfig();
    return String(config?.gateway?.port || DEFAULT_GATEWAY_PORT);
  } catch {
    return DEFAULT_GATEWAY_PORT;
  }
}

function resolveBrowserHeadlessSettings({
  env = process.env,
  configPath = DEFAULT_OPENCLAW_CONFIG_PATH,
  profile = env.OPENCLAW_BROWSER_PROFILE || DEFAULT_SONOS_BROWSER_PROFILE,
} = {}) {
  const envOverride = parseBooleanFlag(env.OPENCLAW_BROWSER_HEADLESS);
  const config = readOpenClawConfig(configPath);
  const profileHeadless = config?.browser?.profiles?.[profile]?.headless;

  if (envOverride !== null) {
    return {
      enabled: envOverride,
      source: 'env',
      config,
    };
  }

  if (typeof profileHeadless === 'boolean') {
    return {
      enabled: profileHeadless,
      source: 'profile-config',
      config,
    };
  }

  return {
    enabled: config?.browser?.headless === true,
    source: 'global-config',
    config,
  };
}

export function resolveBrowserHeadlessMode(options = {}) {
  return resolveBrowserHeadlessSettings(options).enabled;
}

export function isRetryableBrowserAttachError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('gateway timeout after 20000ms') ||
    text.includes('gateway timeout') ||
    text.includes('etimedout') ||
    text.includes('timed out') ||
    text.includes('econnreset') ||
    text.includes('socket hang up') ||
    text.includes('fetch failed') ||
    text.includes('network error') ||
    text.includes('connection closed') ||
    text.includes('websocket closed') ||
    text.includes('write eof')
  );
}

export function summarizeBrowserAttachError(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  if (isRetryableBrowserAttachError(text)) {
    return 'OpenClaw browser gateway attach timed out or the local socket dropped during attach.';
  }
  return '';
}

function localLoginHelperExists() {
  return fs.existsSync(LOCAL_LOGIN_HELPER);
}

export class PurePlayBrowserRunner {
  constructor({ profile = process.env.OPENCLAW_BROWSER_PROFILE || DEFAULT_SONOS_BROWSER_PROFILE, logger = () => {}, baseUrl = SEARCH_URL } = {}) {
    this.profile = profile;
    this.logger = logger;
    this.baseUrl = baseUrl;
    this.gatewayPort = readGatewayPort();
    this.gatewayHealthUrl = `http://127.0.0.1:${this.gatewayPort}/health`;
    this.profileSetup = assertBrowserProfileSetup({ profile: this.profile });
    this.headless = resolveBrowserHeadlessMode({ profile: this.profile });
    this.configPath = DEFAULT_OPENCLAW_CONFIG_PATH;
  }

  log(event) {
    this.logger({ ok: true, phase: 'browser-runner', ...event });
  }

  interactionMode() {
    return this.headless ? 'headless' : 'foreground';
  }

  requiresForeground() {
    return !this.headless;
  }

  /**
   * Execute an `openclaw browser` command synchronously.
   *
   * Important: `this.profile` is a browser runtime profile and must be passed
   * via `--browser-profile`. Do not replace this with CLI root `--profile`.
   */
  oc(args, { parseJson = true } = {}) {
    const base = ['browser', '--browser-profile', this.profile, '--json', ...args];
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const raw = execFileSync('openclaw', base, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
        });
        if (!parseJson) return raw;
        const trimmed = String(raw || '').trim();
        try {
          return JSON.parse(trimmed);
        } catch {
          const start = trimmed.indexOf('{');
          if (start >= 0) return JSON.parse(trimmed.slice(start));
          throw new Error(`No JSON payload found in output: ${trimmed.slice(0, 400)}`);
        }
      } catch (error) {
        lastError = error;
        const stderr = String(error?.stderr || error?.message || error);
        const stdout = String(error?.stdout || '');
        const rawMessage = `${stderr || stdout}`.trim();
        const retryable = attempt < maxAttempts && isRetryableBrowserAttachError(rawMessage);
        const gatewayHealth = this.readGatewayHealth();

        this.log({
          event: 'browser-command-failed',
          attempt,
          maxAttempts,
          args,
          retryable,
          gatewayHealth,
          message: rawMessage.slice(0, 600),
        });

        if (retryable) {
          this.waitForGatewayRecovery();
          continue;
        }

        const summary = summarizeBrowserAttachError(rawMessage);
        throw new SkillError(
          'browser-runner',
          'BROWSER_ATTACH_FAILED',
          summary ? `${rawMessage} ${summary}`.trim() : rawMessage,
          {
            args,
            profile: this.profile,
            attempt,
            maxAttempts,
            gatewayHealth,
            gatewayHealthUrl: this.gatewayHealthUrl,
          }
        );
      }
    }

    const stderr = String(lastError?.stderr || lastError?.message || lastError || '');
    throw new SkillError('browser-runner', 'BROWSER_ATTACH_FAILED', stderr.trim(), {
      args,
      profile: this.profile,
      gatewayHealthUrl: this.gatewayHealthUrl,
    });
  }

  runLocalLoginHelper() {
    if (!localLoginHelperExists()) {
      return { ok: false, code: 'LOCAL_LOGIN_HELPER_MISSING', helperPath: LOCAL_LOGIN_HELPER };
    }

    const result = spawnSync('node', [LOCAL_LOGIN_HELPER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SONOS_LOGIN_BROWSER_PROFILE: this.profile,
        OPENCLAW_BROWSER_PROFILE: this.profile,
        [LOGIN_RECOVERY_SENTINEL]: '1',
      },
      timeout: 120000,
    });

    const stdout = String(result?.stdout || '').trim();
    const stderr = String(result?.stderr || '').trim();
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return {
      ok: result?.status === 0,
      status: result?.status ?? null,
      signal: result?.signal || null,
      stdout,
      stderr,
      output: combined,
      helperPath: LOCAL_LOGIN_HELPER,
    };
  }

  ensureLoggedInOrRecover(targetId) {
    if (process.env[LOGIN_RECOVERY_SENTINEL] === '1') {
      return { ok: true, recovered: false, state: { bypassed: true } };
    }

    const state = this.readPageState(targetId) || {};
    if (!state.loginBlocked) {
      return { ok: true, recovered: false, state };
    }
    if (state.challengeRequired) {
      throw new SkillError('preflight', 'LOGIN_CHALLENGE_REQUIRED', 'Sonos Web requires additional verification before playback can continue.', {
        profile: this.profile,
        url: state?.url || null,
      });
    }

    const helper = this.runLocalLoginHelper();
    this.log({
      event: 'local-login-helper-run',
      ok: helper.ok,
      status: helper.status,
      output: (helper.output || '').slice(0, 400),
      helperPath: helper.helperPath,
    });

    if (!helper.ok) {
      throw new SkillError('preflight', 'LOGIN_RECOVERY_FAILED', helper.output || 'Local Sonos login helper failed.', {
        profile: this.profile,
        helperPath: helper.helperPath,
      });
    }

    this.waitMs(1800);
    const after = this.readPageState(targetId) || {};
    if (after.challengeRequired) {
      throw new SkillError('preflight', 'LOGIN_CHALLENGE_REQUIRED', 'Sonos Web still requires additional verification after login recovery.', {
        profile: this.profile,
        url: after?.url || null,
      });
    }
    if (after.loginBlocked) {
      throw new SkillError('preflight', 'LOGIN_RECOVERY_FAILED', 'Sonos Web still appears logged out after login recovery.', {
        profile: this.profile,
        helperPath: helper.helperPath,
        url: after?.url || null,
      });
    }
    return { ok: true, recovered: true, state: after, helperOutput: helper.output };
  }

  readGatewayHealth() {
    try {
      const raw = execFileSync('curl', ['-sS', '-m', '3', this.gatewayHealthUrl], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const trimmed = String(raw || '').trim();
      const parsed = trimmed ? JSON.parse(trimmed) : null;
      return {
        ok: !!parsed?.ok,
        status: parsed?.status || null,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 300),
      };
    }
  }

  waitForGatewayRecovery() {
    const startedAt = Date.now();
    const deadline = startedAt + 10000;
    let lastHealth = null;

    while (Date.now() < deadline) {
      lastHealth = this.readGatewayHealth();
      if (lastHealth?.ok && lastHealth?.status === 'live') {
        this.waitMs(1200);
        this.log({
          event: 'gateway-recovered',
          elapsedMs: Date.now() - startedAt,
          gatewayHealth: lastHealth,
        });
        return lastHealth;
      }
      this.log({
        event: 'gateway-recovery-poll',
        elapsedMs: Date.now() - startedAt,
        gatewayHealth: lastHealth,
      });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }

    this.log({
      event: 'gateway-recovery-timeout',
      elapsedMs: Date.now() - startedAt,
      gatewayHealth: lastHealth,
    });
    return lastHealth;
  }

  tabs() {
    return tabsTool(this);
  }

  focus(targetId) {
    focusTool(this, targetId);
  }

  close(targetId) {
    closeTool(this, targetId);
  }

  waitMs(ms) {
    waitMsTool(this, ms);
  }

  waitForLoad(targetId) {
    waitForLoadTool(this, targetId);
  }

  navigate(targetId, url) {
    navigateTool(this, targetId, url);
  }

  press(targetId, key) {
    pressTool(this, targetId, key);
  }

  typeRef(targetId, ref, text, { submit = false } = {}) {
    return typeRefTool(this, targetId, ref, text, { submit });
  }

  fillRef(targetId, ref, value) {
    return fillRefTool(this, targetId, ref, value);
  }

  type(targetId, text) {
    return typeTool(this, targetId, text);
  }

  click(targetId, ref) {
    clickTool(this, targetId, ref);
  }

  start() {
    startTool(this);
  }

  clickButtonByLabel(targetId, labels = []) {
    return clickButtonByLabelTool(this, targetId, labels);
  }

  openPlaybackActionMenu(targetId, options = {}) {
    return openPlaybackActionMenuTool(this, targetId, options);
  }

  choosePlaybackAction(targetId, labels = ['替换队列', '立即播放'], options = {}) {
    return choosePlaybackActionTool(this, targetId, labels, options);
  }

  snapshot(targetId, limit = 260) {
    const shot = snapshotTool(this, targetId, limit);
    if (!shot?.ok || !Array.isArray(shot.nodes)) {
      throw new SkillError('snapshot', 'SNAPSHOT_FAILED', 'Failed to capture Sonos snapshot.', { targetId });
    }
    return shot;
  }

  snapshotAi(targetId, limit = 260) {
    const snapshot = snapshotAiTool(this, targetId, limit);
    if (!snapshot?.ok || !snapshot?.refs || typeof snapshot.refs !== 'object') {
      throw new SkillError('snapshot', 'SNAPSHOT_FAILED', 'Failed to capture Sonos AI snapshot.', { targetId });
    }
    return snapshot;
  }

  evaluate(targetId, fnSource) {
    return evaluateTool(this, targetId, fnSource);
  }

  ensureSonosTab() {
    return ensureSonosTabTool(this);
  }

  readPageState(targetId) {
    return readPageStateTool(this, targetId);
  }

  readVisibleMenuItems(targetId) {
    return readVisibleMenuItemsTool(this, targetId);
  }

  readRoomSyncState(targetId, room) {
    return readRoomSyncStateTool(this, targetId, room);
  }

  clickRoomActivate(targetId, room) {
    return clickRoomActivateTool(this, targetId, room);
  }

  readRoomContext(targetId) {
    return readRoomContextTool(this, targetId);
  }

  screenshotRoot(targetId) {
    return screenshotRootTool(this, targetId);
  }

  extractUsablePageBlocks(targetId) {
    return extractUsablePageBlocksTool(this, targetId);
  }
}
