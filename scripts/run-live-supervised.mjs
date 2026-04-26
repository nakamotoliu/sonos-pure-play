#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { notifyFailureArtifact } from './failure-notify.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(SCRIPT_DIR, '..', 'logs');
const RUN_RECORD_PATH = path.join(LOG_DIR, 'run-records.local.jsonl');
const ARTIFACT_DIR = path.join(LOG_DIR, 'failure-artifacts.local');
const PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless';
const IDLE_TIMEOUT_MS = Number(process.env.SONOS_RUN_IDLE_TIMEOUT_MS || 0);
const HARD_TIMEOUT_MS = Number(process.env.SONOS_RUN_HARD_TIMEOUT_MS || 600000);
const STEP_IDLE_TIMEOUT_MS = Number(process.env.SONOS_RUN_STEP_IDLE_TIMEOUT_MS || 0);
const STEP_IDLE_TIMEOUTS_MS = {
  'ensure-sonos-tab': Number(process.env.SONOS_STEP_TIMEOUT_ENSURE_TAB_MS || 60000),
  'room-sync-read-before': Number(process.env.SONOS_STEP_TIMEOUT_ROOM_SYNC_MS || 20000),
  'room-sync-activate': Number(process.env.SONOS_STEP_TIMEOUT_ROOM_SYNC_ACTIVATE_MS || 20000),
  'room-sync-read-after': Number(process.env.SONOS_STEP_TIMEOUT_ROOM_SYNC_MS || 20000),
  navigate: Number(process.env.SONOS_STEP_TIMEOUT_NAVIGATE_MS || 30000),
  'query-gate': Number(process.env.SONOS_STEP_TIMEOUT_QUERY_GATE_MS || 40000),
  'surface-read': Number(process.env.SONOS_STEP_TIMEOUT_SURFACE_MS || 20000),
  'candidate-click': Number(process.env.SONOS_STEP_TIMEOUT_CANDIDATE_CLICK_MS || 30000),
  'playback-action': Number(process.env.SONOS_STEP_TIMEOUT_PLAYBACK_ACTION_MS || 40000),
};

function appendRunRecord(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(RUN_RECORD_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function sanitize(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'step';
}

function baseName(step) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitize(step)}`;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/("(?:sonosId|luid|auid|salesforceContactId|salesforceAccountId|email|ip)"\s*:\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/("accessTokenStatus"\s*:\s*)\{[^{}]*\}/gi, '$1"[redacted]"');
}

function redactSensitiveValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry));
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/email|ip|sonosId|luid|auid|salesforce|token|authorization|cookie/i.test(key)) {
        redacted[key] = '[redacted]';
      } else {
        redacted[key] = redactSensitiveValue(entry);
      }
    }
    return redacted;
  }
  return value;
}

function ocJson(args) {
  const raw = execFileSync('openclaw', ['browser', '--browser-profile', PROFILE, '--json', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }).trim();
  return raw ? JSON.parse(raw) : null;
}

function captureScreenshot(targetId) {
  const raw = execFileSync('openclaw', ['browser', '--browser-profile', PROFILE, 'screenshot', targetId], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }).trim();
  const match = raw.match(/MEDIA:(.+)$/m);
  return match ? match[1].trim() : null;
}

function readPageState(targetId) {
  try {
    return ocJson([
      'evaluate',
      '--target-id',
      targetId,
      '--fn',
      `() => ({ url: location.href, title: document.title || '', bodyPreview: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1600) })`,
    ])?.result || null;
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function sanitizePageState(pageState) {
  if (!pageState) return pageState;
  const sanitized = redactSensitiveValue(pageState);
  if (sanitized && typeof sanitized === 'object' && typeof sanitized.bodyPreview === 'string') {
    sanitized.bodyPreview = redactSensitiveText(sanitized.bodyPreview).slice(0, 800);
  }
  return sanitized;
}

async function main() {
  const [roomInput, ...requestParts] = process.argv.slice(2);
  const request = requestParts.join(' ').trim();
  if (!roomInput || !request) {
    console.error('Usage: node skills/sonos-pure-play/scripts/run-live-supervised.mjs <room> <request>');
    process.exit(2);
  }

  const child = spawn('node', [path.join(SCRIPT_DIR, 'run-live-once.mjs'), roomInput, request], {
    cwd: path.join(SCRIPT_DIR, '..', '..', '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  let latestStep = null;
  let latestTargetId = null;
  let lastProgressAt = Date.now();
  let latestStepStartedAt = Date.now();
  let latestEnsureStage = null;
  let latestEnsureStageStartedAt = null;
  const tail = [];

  const markProgress = () => {
    lastProgressAt = Date.now();
  };

  const onChunk = (chunk) => {
    const text = String(chunk || '');
    process.stdout.write(text);
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      tail.push(redactSensitiveText(trimmed));
      if (tail.length > 40) tail.shift();
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.phase === 'browser-runner' && parsed?.event === 'step-start') {
          latestStep = parsed.step || latestStep;
          latestStepStartedAt = Date.now();
        }
        if (parsed?.phase === 'browser-runner' && parsed?.event === 'step-ok') {
          latestStepStartedAt = Date.now();
          latestStep = null;
        }
        if (parsed?.phase === 'browser-runner' && parsed?.event === 'ensure-sonos-tab-stage-start') {
          latestEnsureStage = parsed.stage || latestEnsureStage;
          latestEnsureStageStartedAt = Date.now();
        }
        if (
          parsed?.phase === 'browser-runner'
          && (parsed?.event === 'ensure-sonos-tab-stage-ok' || parsed?.event === 'ensure-sonos-tab-stage-failed')
        ) {
          latestEnsureStageStartedAt = Date.now();
        }
        if (parsed?.targetId) latestTargetId = parsed.targetId;
        if (parsed?.verifyResult?.targetId) latestTargetId = parsed.verifyResult.targetId;
        if (
          parsed?.phase ||
          parsed?.event ||
          parsed?.kind ||
          parsed?.step ||
          parsed?.targetId ||
          parsed?.verifyResult
        ) {
          markProgress();
        }
      } catch {}
    }
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  let finalized = false;
  const finalizeTimeout = (reason, timeoutMs) => {
    if (finalized) return;
    finalized = true;

    const step = latestStep || latestEnsureStage || reason;
    let screenshotPath = null;
    let artifactPath = null;
    let pageState = null;

    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      if (latestTargetId) {
        const captured = captureScreenshot(latestTargetId);
        if (captured && fs.existsSync(captured)) {
          const ext = path.extname(captured) || '.png';
          screenshotPath = path.join(ARTIFACT_DIR, `${baseName(step)}${ext}`);
          fs.copyFileSync(captured, screenshotPath);
        }
        pageState = readPageState(latestTargetId);
      }
      artifactPath = path.join(ARTIFACT_DIR, `${baseName(step)}.json`);
      fs.writeFileSync(artifactPath, JSON.stringify({
        ok: false,
        reason,
        step,
        targetId: latestTargetId,
        profile: PROFILE,
        timeoutMs,
        idleForMs: Date.now() - lastProgressAt,
        stepIdleForMs: Date.now() - latestStepStartedAt,
        ensureStage: latestEnsureStage,
        ensureStageIdleForMs: latestEnsureStageStartedAt ? (Date.now() - latestEnsureStageStartedAt) : null,
        capturedAt: new Date().toISOString(),
        screenshotPath,
        pageState: sanitizePageState(pageState),
        logTail: tail.map(redactSensitiveText),
      }, null, 2));
      appendRunRecord({
        kind: reason,
        step,
        ensureStage: latestEnsureStage,
        ensureStageIdleForMs: latestEnsureStageStartedAt ? (Date.now() - latestEnsureStageStartedAt) : null,
        targetId: latestTargetId,
        timeoutMs,
        idleForMs: Date.now() - lastProgressAt,
        stepIdleForMs: Date.now() - latestStepStartedAt,
        artifactPath,
        screenshotPath,
      });
      try {
        const notifyResult = notifyFailureArtifact({
          capturedAt: new Date().toISOString(),
          step,
          room: roomInput,
          request,
          targetId: latestTargetId,
          artifactPath,
          screenshotPath,
          timeoutMs,
          error: { message: reason },
        });
        appendRunRecord({ kind: 'failure-notified', notifyResult, artifactPath, screenshotPath });
      } catch (notifyError) {
        appendRunRecord({
          kind: 'failure-notify-failed',
          step,
          artifactPath,
          screenshotPath,
          message: String(notifyError?.message || notifyError),
        });
      }
    } catch (error) {
      appendRunRecord({
        kind: `${reason}-capture-failed`,
        step,
        targetId: latestTargetId,
        timeoutMs,
        message: String(error?.message || error),
      });
    }

    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 3000);
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    const stepName = String(latestStep || '');
    const configuredStepIdle = STEP_IDLE_TIMEOUTS_MS[stepName] || STEP_IDLE_TIMEOUT_MS || 0;
    const idleLimit = configuredStepIdle > 0 ? configuredStepIdle : IDLE_TIMEOUT_MS;
    if (!idleLimit || idleLimit <= 0) return;
    const idleForMs = now - lastProgressAt;
    const stepIdleForMs = now - latestStepStartedAt;
    if (idleForMs >= idleLimit && stepIdleForMs >= idleLimit) {
      finalizeTimeout('supervised-idle-timeout', idleLimit);
    }
  }, 1000);

  const hardTimer = setTimeout(() => {
    finalizeTimeout('supervised-hard-timeout', HARD_TIMEOUT_MS);
  }, HARD_TIMEOUT_MS);

  child.on('exit', (code, signal) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    process.stdout.write(buffer);
    appendRunRecord({
      kind: 'supervised-exit',
      roomInput,
      request,
      code,
      signal,
      latestStep,
      latestEnsureStage,
      latestTargetId,
      idleForMs: Date.now() - lastProgressAt,
      stepIdleForMs: Date.now() - latestStepStartedAt,
      ensureStageIdleForMs: latestEnsureStageStartedAt ? (Date.now() - latestEnsureStageStartedAt) : null,
    });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
