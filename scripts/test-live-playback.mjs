#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(SCRIPT_DIR, '..');
const WORKDIR = path.join(SKILL_DIR, '..', '..', '..');
const RUN_RECORD_PATH = path.join(SKILL_DIR, 'logs', 'run-records.local.jsonl');
const SUPERVISED_RUNNER = path.join(SCRIPT_DIR, 'run-live-supervised.mjs');

function usage() {
  console.log([
    'Usage:',
    '  node skills/sonos-pure-play/scripts/test-live-playback.mjs <room> <request1> [<request2> ...]',
    '',
    'Examples:',
    '  node skills/sonos-pure-play/scripts/test-live-playback.mjs 客厅 "王菲热歌"',
    '  node skills/sonos-pure-play/scripts/test-live-playback.mjs 客厅 "王菲热歌" "周杰伦热歌"',
    '',
    'What this does:',
    '  - runs the real supervised Sonos playback flow',
    '  - drives the actual Sonos Web page in the configured browser profile',
    '  - requires final playback verification to pass',
    '  - exits non-zero if any case fails',
  ].join('\n'));
}

function readRecentRunRecords({ startedAtMs }) {
  if (!fs.existsSync(RUN_RECORD_PATH)) return [];
  const raw = fs.readFileSync(RUN_RECORD_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean).slice(-2000);
  const records = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const ts = Date.parse(parsed?.ts || '');
      if (Number.isFinite(ts) && ts >= startedAtMs - 1000) records.push(parsed);
    } catch {}
  }
  return records;
}

function summarizeRecentRecords(records, request) {
  const scoped = records.filter((entry) => {
    if (entry?.request === request || entry?.roomInput || entry?.room) return true;
    return ['supervised-timeout', 'failure-notified', 'run-failed', 'supervised-exit'].includes(entry?.kind);
  });
  const runSucceeded = [...scoped].reverse().find((entry) => entry?.kind === 'run-succeeded' && entry?.request === request) || null;
  const runFailed = [...scoped].reverse().find((entry) => entry?.kind === 'run-failed') || null;
  const timeout = [...scoped].reverse().find((entry) => entry?.kind === 'supervised-idle-timeout' || entry?.kind === 'supervised-hard-timeout' || entry?.kind === 'supervised-timeout') || null;
  const notified = [...scoped].reverse().find((entry) => entry?.kind === 'failure-notified' || entry?.kind === 'success-notified') || null;
  const exit = [...scoped].reverse().find((entry) => entry?.kind === 'supervised-exit' && entry?.request === request) || null;
  return { runSucceeded, runFailed, timeout, notified, exit };
}

function parseJsonLinesFromOutput(text) {
  const parsed = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {}
  }
  return parsed;
}

async function runCase({ index, total, room, request }) {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  console.log(`\n=== [${index}/${total}] REAL SONOS TEST: ${room} / ${request} ===`);

  const child = spawn('node', [SUPERVISED_RUNNER, room, request], {
    cwd: WORKDIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.on('data', (chunk) => {
    const text = String(chunk || '');
    stdoutBuffer += text;
    process.stdout.write(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    stderrBuffer += text;
    process.stderr.write(text);
  });

  const exit = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const durationMs = Date.now() - startedAtMs;
  const outputJson = parseJsonLinesFromOutput(`${stdoutBuffer}\n${stderrBuffer}`);
  const successPayload = [...outputJson].reverse().find((entry) => entry?.ok === true && entry?.report) || null;
  const failurePayload = [...outputJson].reverse().find((entry) => entry?.ok === false) || null;
  const recentRecords = readRecentRunRecords({ startedAtMs });
  const recordSummary = summarizeRecentRecords(recentRecords, request);
  const runSucceeded = recordSummary.runSucceeded;

  const passed = Boolean(exit.code === 0 && successPayload && runSucceeded);
  const finalTitle = runSucceeded?.playbackVerifyResult?.finalTitle || successPayload?.report?.playbackVerifyResult?.finalTitle || null;
  const finalTrack = runSucceeded?.playbackVerifyResult?.finalTrack || successPayload?.report?.playbackVerifyResult?.finalTrack || null;
  const chosenTitle = runSucceeded?.chosenCandidate?.title || successPayload?.report?.chosenCandidate?.title || null;
  const artifactPath = recordSummary.timeout?.artifactPath || recordSummary.runFailed?.evidence?.artifactPath || null;
  const ensureStage = recordSummary.timeout?.ensureStage || recordSummary.exit?.latestEnsureStage || null;

  console.log(`--- RESULT: ${passed ? 'PASS' : 'FAIL'} (${Math.round(durationMs / 1000)}s)`);
  if (chosenTitle) console.log(`chosen: ${chosenTitle}`);
  if (finalTitle || finalTrack) console.log(`playback: ${finalTitle || '?'} / track ${finalTrack || '?'}`);
  if (!passed) {
    if (failurePayload?.code || failurePayload?.message) {
      console.log(`failure: ${failurePayload?.code || 'UNKNOWN'} ${failurePayload?.message || ''}`.trim());
    }
    if (ensureStage) console.log(`ensureSonosTab stage: ${ensureStage}`);
    if (artifactPath) console.log(`artifact: ${artifactPath}`);
  }

  return {
    room,
    request,
    startedAt: startedAtIso,
    durationMs,
    passed,
    exit,
    chosenTitle,
    finalTitle,
    finalTrack,
    artifactPath,
    ensureStage,
    successPayload,
    failurePayload,
    recordSummary,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const cleanedArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i] || '').trim();
    if (!value) continue;
    if (value === '--volume' || value === '-v') {
      i += 1;
      continue;
    }
    if (value.startsWith('--volume=')) continue;
    cleanedArgs.push(value);
  }

  const [room, ...requests] = cleanedArgs;
  if (!room || requests.length === 0) {
    usage();
    process.exit(2);
  }

  const results = [];
  for (let i = 0; i < requests.length; i += 1) {
    const result = await runCase({ index: i + 1, total: requests.length, room, request: requests[i] });
    results.push(result);
  }

  const passedCount = results.filter((item) => item.passed).length;
  const summary = {
    ok: passedCount === results.length,
    room,
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    cases: results.map((item) => ({
      request: item.request,
      passed: item.passed,
      durationMs: item.durationMs,
      chosenTitle: item.chosenTitle,
      finalTitle: item.finalTitle,
      finalTrack: item.finalTrack,
      artifactPath: item.artifactPath,
      ensureStage: item.ensureStage,
    })),
  };

  console.log('\n=== REAL SONOS TEST SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
