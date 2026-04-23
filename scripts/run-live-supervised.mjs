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
const PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw';
const TIMEOUT_MS = Number(process.env.SONOS_RUN_TIMEOUT_MS || 120000);

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
  const tail = [];

  const onChunk = (chunk) => {
    const text = String(chunk || '');
    process.stdout.write(text);
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      tail.push(trimmed);
      if (tail.length > 40) tail.shift();
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.phase === 'browser-runner' && parsed?.event === 'step-start') latestStep = parsed.step || latestStep;
        if (parsed?.targetId) latestTargetId = parsed.targetId;
        if (parsed?.verifyResult?.targetId) latestTargetId = parsed.verifyResult.targetId;
      } catch {}
    }
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const timer = setTimeout(() => {
    const step = latestStep || 'supervised-timeout';
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
        reason: 'supervised-timeout',
        step,
        targetId: latestTargetId,
        profile: PROFILE,
        timeoutMs: TIMEOUT_MS,
        capturedAt: new Date().toISOString(),
        screenshotPath,
        pageState,
        logTail: tail,
      }, null, 2));
      appendRunRecord({
        kind: 'supervised-timeout',
        step,
        targetId: latestTargetId,
        timeoutMs: TIMEOUT_MS,
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
          timeoutMs: TIMEOUT_MS,
          error: { message: 'supervised-timeout' },
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
        kind: 'supervised-timeout-capture-failed',
        step,
        targetId: latestTargetId,
        timeoutMs: TIMEOUT_MS,
        message: String(error?.message || error),
      });
    }

    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 3000);
  }, TIMEOUT_MS);

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    process.stdout.write(buffer);
    appendRunRecord({
      kind: 'supervised-exit',
      roomInput,
      request,
      code,
      signal,
      latestStep,
      latestTargetId,
    });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
