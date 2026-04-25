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
import {
  checkSearchQueryApplied as checkSearchQueryAppliedTool,
  ensureQueryGate as ensureQueryGateTool,
  replaceVisibleSearchValue as replaceVisibleSearchValueTool,
} from './search-input-ops.mjs';
import { buildDetectSearchPageStateFn } from './search-page-state.mjs';
import {
  clickLoginButton as clickLoginButtonTool,
  replaceVisibleLoginValue as replaceVisibleLoginValueTool,
} from './login-input-ops.mjs';

const DEFAULT_GATEWAY_PORT = '18789';
const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_SONOS_BROWSER_PROFILE = 'openclaw';
const LOGIN_RECOVERY_SENTINEL = '__SONOS_LOGIN_RECOVERY_ACTIVE__';
const LOCAL_LOGIN_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'login-recovery.local.mjs');
const DEFAULT_FAILURE_ARTIFACT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'failure-artifacts.local');
const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = Number(process.env.SONOS_BROWSER_COMMAND_TIMEOUT_MS || 90000);

function sanitizeArtifactSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'step';
}

export function buildStepArtifactBasename(step, now = new Date()) {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${iso}-${sanitizeArtifactSegment(step)}`;
}

export function normalizeStepGateResult(value) {
  if (typeof value === 'undefined') return { ok: true };
  if (typeof value === 'boolean') return { ok: value };
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok')) return value;
  return {
    ok: Boolean(value),
    value,
  };
}

function readOpenClawConfig(configPath = DEFAULT_OPENCLAW_CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function listRuntimeBrowserProfiles() {
  try {
    const raw = execFileSync('openclaw', ['browser', '--json', 'profiles'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const trimmed = String(raw || '').trim();
    const parsed = trimmed ? JSON.parse(trimmed) : null;
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];

    return entries
      .map((entry) => {
        if (typeof entry === 'string') return { name: entry };
        const name = String(entry?.name || entry?.profile || '').trim();
        if (!name) return null;
        return { ...entry, name };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function inspectBrowserProfileSetup({
  env = process.env,
  configPath = DEFAULT_OPENCLAW_CONFIG_PATH,
  profile = env.OPENCLAW_BROWSER_PROFILE || DEFAULT_SONOS_BROWSER_PROFILE,
  runtimeProfiles = null,
} = {}) {
  const config = readOpenClawConfig(configPath);
  const configuredProfile = config?.browser?.profiles?.[profile] || null;
  const availableRuntimeProfiles = Array.isArray(runtimeProfiles) ? runtimeProfiles : listRuntimeBrowserProfiles();
  const runtimeProfile = availableRuntimeProfiles.find((entry) => String(entry?.name || '') === profile) || null;

  return {
    profile,
    configPath,
    config,
    configExists: !!config,
    browserEnabled: config?.browser?.enabled !== false,
    runtimeProfiles: availableRuntimeProfiles,
    runtimeProfileExists: !!runtimeProfile,
    runtimeProfile,
    profileExists: !!configuredProfile || !!runtimeProfile,
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
      `Browser profile "${setup.profile}" is not available. Configure browser.profiles.${setup.profile} or make sure the runtime profile exists before running this Sonos skill.`,
      {
        profile: setup.profile,
        configPath: setup.configPath,
        runtimeProfiles: setup.runtimeProfiles,
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

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!duration) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
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
    text.includes('write eof') ||
    text.includes('couldn\'t connect to server') ||
    text.includes('failed to connect to 127.0.0.1')
  );
}

export function isTabNotFoundBrowserError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('tab not found') || text.includes('target closed') || text.includes('no tab found');
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
  constructor({ profile = process.env.OPENCLAW_BROWSER_PROFILE || DEFAULT_SONOS_BROWSER_PROFILE, logger = () => {}, baseUrl = SEARCH_URL, artifactRoot = DEFAULT_FAILURE_ARTIFACT_ROOT } = {}) {
    this.profile = profile;
    this.logger = logger;
    this.baseUrl = baseUrl;
    this.artifactRoot = artifactRoot;
    this.gatewayPort = readGatewayPort();
    this.gatewayHealthUrl = `http://127.0.0.1:${this.gatewayPort}/health`;
    this.profileSetup = assertBrowserProfileSetup({ profile: this.profile });
    this.headless = resolveBrowserHeadlessMode({ profile: this.profile });
    this.configPath = DEFAULT_OPENCLAW_CONFIG_PATH;
    this.browserCommandTimeoutMs = DEFAULT_BROWSER_COMMAND_TIMEOUT_MS;
    this.currentStep = null;
    this.currentTargetId = null;
    this.currentStepContext = null;
    this.targetUrlHints = new Map();
  }

  log(event) {
    this.logger({ ok: true, phase: 'browser-runner', ...event });
  }

  interactionMode() {
    return this.headless ? 'headless' : 'foreground';
  }

  ensureArtifactRoot() {
    fs.mkdirSync(this.artifactRoot, { recursive: true });
    return this.artifactRoot;
  }

  captureFailureEvidence(step, { targetId = null, error = null, context = {} } = {}) {
    const baseName = buildStepArtifactBasename(step);
    const dir = this.ensureArtifactRoot();
    const artifactPath = path.join(dir, `${baseName}.json`);
    const safeCall = (label, fn) => {
      try {
        return { ok: true, label, value: fn() };
      } catch (innerError) {
        return {
          ok: false,
          label,
          error: String(innerError?.message || innerError),
          code: innerError?.code || null,
          phase: innerError?.phase || null,
          data: innerError?.data || null,
        };
      }
    };

    const pageState = targetId ? safeCall('pageState', () => this.readPageState(targetId)) : null;
    const roomContext = targetId ? safeCall('roomContext', () => this.readRoomContext(targetId)) : null;
    const snapshot = targetId ? safeCall('snapshot', () => this.snapshot(targetId, 180)) : null;
    const snapshotAi = targetId ? safeCall('snapshotAi', () => this.snapshotAi(targetId, 180)) : null;
    const screenshot = targetId ? safeCall('screenshotRoot', () => this.screenshotRoot(targetId)) : null;

    let screenshotCopyPath = null;
    const mediaPath = screenshot?.ok ? screenshot?.value?.mediaPath : null;
    if (mediaPath && fs.existsSync(mediaPath)) {
      const ext = path.extname(mediaPath) || '.png';
      screenshotCopyPath = path.join(dir, `${baseName}${ext}`);
      try {
        fs.copyFileSync(mediaPath, screenshotCopyPath);
      } catch {
        screenshotCopyPath = null;
      }
    }

    const payload = {
      ok: true,
      step,
      targetId,
      capturedAt: new Date().toISOString(),
      profile: this.profile,
      interactionMode: this.interactionMode?.() || null,
      gatewayHealth: typeof this.readGatewayHealth === 'function' ? this.readGatewayHealth() : null,
      context,
      activeStep: this.currentStep,
      error: error
        ? {
            message: String(error?.message || error),
            code: error?.code || null,
            phase: error?.phase || null,
            data: error?.data || null,
            stack: error?.stack || null,
          }
        : null,
      pageState,
      roomContext,
      snapshot,
      snapshotAi,
      screenshot: screenshot
        ? {
            ...screenshot,
            mediaPath,
            copyPath: screenshotCopyPath,
          }
        : null,
    };

    fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2));
    this.log({
      event: 'failure-evidence-captured',
      step,
      targetId,
      artifactPath,
      screenshotPath: screenshotCopyPath || mediaPath || null,
    });

    return {
      ok: true,
      artifactPath,
      screenshotPath: screenshotCopyPath || mediaPath || null,
    };
  }

  runStep(step, { targetId = null, context = {}, action, verify } = {}) {
    this.log({ event: 'step-start', step, targetId, context });
    this.currentStep = step;
    this.currentTargetId = targetId;
    this.currentStepContext = context;
    try {
      const actionResult = typeof action === 'function' ? action() : undefined;
      const verifyResult = normalizeStepGateResult(typeof verify === 'function' ? verify(actionResult) : undefined);
      if (!verifyResult.ok) {
        throw new SkillError('step-gate', 'STEP_VERIFICATION_FAILED', `Step "${step}" verification failed.`, {
          step,
          targetId,
          context,
          verifyResult,
          actionResult,
        });
      }
      this.log({ event: 'step-ok', step, targetId, context, verifyResult });
      this.currentStep = null;
      this.currentTargetId = null;
      this.currentStepContext = null;
      return {
        ok: true,
        step,
        actionResult,
        verifyResult,
      };
    } catch (error) {
      const evidence = this.captureFailureEvidence(step, { targetId, error, context });
      let finalError = error;
      if (finalError instanceof SkillError) {
        finalError.data = {
          ...(finalError.data || {}),
          step,
          targetId,
          context,
          evidence,
        };
      } else {
        finalError = new SkillError('step-gate', 'STEP_EXECUTION_FAILED', String(error?.message || error), {
          step,
          targetId,
          context,
          evidence,
        });
      }
      this.log({
        event: 'step-failed',
        step,
        targetId,
        context,
        code: finalError?.code || null,
        message: String(finalError?.message || finalError),
        evidence,
      });
      this.currentStep = null;
      this.currentTargetId = null;
      this.currentStepContext = null;
      throw finalError;
    }
  }

  waitForCondition(label, fn, { timeoutMs = 4000, intervalMs = 0, ready = (value) => Boolean(value?.ok) } = {}) {
    const startedAt = Date.now();
    const attempts = [];

    while (Date.now() - startedAt <= timeoutMs) {
      let value;
      try {
        value = fn();
      } catch (error) {
        value = {
          ok: false,
          error: String(error?.message || error),
        };
      }

      attempts.push(value);
      if (ready(value)) {
        return {
          ok: true,
          label,
          elapsedMs: Date.now() - startedAt,
          attempts,
          result: value,
        };
      }

      if (!intervalMs || Date.now() - startedAt + intervalMs > timeoutMs) break;
      this.waitMs(intervalMs);
    }

    return {
      ok: false,
      label,
      elapsedMs: Date.now() - startedAt,
      attempts,
      result: attempts[attempts.length - 1] || null,
    };
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
    const base = ['browser', '--browser-profile', this.profile, ...(parseJson ? ['--json'] : []), ...args];
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const raw = execFileSync('openclaw', base, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: this.browserCommandTimeoutMs,
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

  ensureLoggedInOrRecover(targetId, { initialState = null } = {}) {
    if (process.env[LOGIN_RECOVERY_SENTINEL] === '1') {
      return { ok: true, recovered: false, state: { bypassed: true } };
    }

    const state = initialState || this.readPageState(targetId) || {};
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
        sleepMs(1200);
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
      sleepMs(800);
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

  rememberTargetUrl(targetId, url) {
    if (!targetId || !url) return;
    this.targetUrlHints.set(String(targetId), String(url));
  }

  getKnownTargetUrl(targetId) {
    if (!targetId) return null;
    return this.targetUrlHints.get(String(targetId)) || null;
  }

  forgetTargetUrl(targetId) {
    if (!targetId) return;
    this.targetUrlHints.delete(String(targetId));
  }

  focus(targetId) {
    focusTool(this, targetId);
  }

  close(targetId) {
    this.forgetTargetUrl(targetId);
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
    this.log({ event: 'generic-fill-ref-used', targetId, ref });
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
    this.log({ event: 'generic-click-button-used', targetId, labels });
    return clickButtonByLabelTool(this, targetId, labels);
  }

  replaceVisibleLoginValue(targetId, kind, value) {
    return replaceVisibleLoginValueTool(this, targetId, kind, value);
  }

  clickLoginButton(targetId) {
    return clickLoginButtonTool(this, targetId);
  }

  replaceVisibleSearchValue(targetId, query, options = {}) {
    return replaceVisibleSearchValueTool(this, targetId, query, options);
  }

  checkSearchQueryApplied(targetId, query) {
    return checkSearchQueryAppliedTool(this, targetId, query);
  }

  ensureQueryGate(targetId, query, options = {}) {
    return ensureQueryGateTool(this, targetId, query, options);
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

  readSearchPageState(targetId, query = '') {
    const evaluated = this.evaluate(targetId, buildDetectSearchPageStateFn({ expectedQuery: query }));
    return evaluated?.result || evaluated;
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

  navigateVerified(targetId, url, { settleMs = 900 } = {}) {
    return this.runStep('navigate', {
      targetId,
      context: { url, settleMs },
      action: () => {
        const knownUrl = this.getKnownTargetUrl(targetId);
        if (knownUrl === url) {
          const liveState = this.readPageState(targetId);
          const liveUrl = typeof liveState?.url === 'string' ? liveState.url : '';
          if (liveUrl === url) {
            this.log({
              event: 'navigate-skipped-known-url',
              targetId,
              url,
            });
            return { url, skipped: true, knownUrl, liveUrl };
          }
          this.log({
            event: 'navigate-hint-stale',
            targetId,
            url,
            knownUrl,
            liveUrl,
          });
          this.forgetTargetUrl(targetId);
        }
        this.navigate(targetId, url);
        this.waitForLoad(targetId);
        this.waitMs(settleMs);
        this.rememberTargetUrl(targetId, url);
        return { url, skipped: false };
      },
      verify: (state) => ({
        ok: true,
        state,
      }),
    });
  }

  recoverSearchPageVerified(targetId, query = '', { settleMs = 900 } = {}) {
    const searchUrl = 'https://play.sonos.com/zh-cn/search';
    return this.runStep('recover-search-page', {
      targetId,
      context: { url: searchUrl, query, settleMs },
      action: () => {
        this.forgetTargetUrl(targetId);
        this.navigate(targetId, searchUrl);
        this.waitForLoad(targetId);
        this.waitMs(settleMs);
        const state = this.readSearchPageState(targetId, query);
        this.rememberTargetUrl(targetId, searchUrl);
        return { url: searchUrl, state };
      },
      verify: (result) => ({
        ok: Boolean(result?.state?.onSearchPage && result?.state?.searchPageReady),
        result,
      }),
    });
  }

  ensureQueryGateVerified(targetId, query, options = {}) {
    return this.runStep('query-gate', {
      targetId,
      context: { query, options },
      action: () => this.ensureQueryGate(targetId, query, options),
      verify: (result) => ({ ok: Boolean(result?.ok), result }),
    });
  }

  choosePlaybackActionVerified(targetId, labels = ['替换队列', '立即播放'], options = {}) {
    return this.runStep('playback-action', {
      targetId,
      context: { labels, options },
      action: () => this.choosePlaybackAction(targetId, labels, options),
      verify: (result) => ({
        ok: Boolean(result?.ok && result?.actualLabel),
        result,
      }),
    });
  }
}
