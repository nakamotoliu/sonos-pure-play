import { spawnSync } from 'node:child_process';

import { SkillError, getQueueCount } from './normalize.mjs';

function sleepMs(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // intentional busy-wait; these retries are short and keep this CLI helper simple/sync
  }
}

function runSonos(args, phase, code, options = {}) {
  const {
    timeoutMs,
    attempts = 1,
    retryDelayMs = 0,
    retryOn = () => true,
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync('sonos', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });

    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();

    if (!result.error && result.status === 0) {
      return stdout;
    }

    const message = result.error
      ? result.error.message
      : stderr || stdout || 'sonos command failed';

    lastError = {
      attempt,
      args,
      exitCode: result.status,
      timeoutMs: timeoutMs || null,
      stdout,
      stderr,
      signal: result.signal || null,
      message,
    };

    if (attempt < attempts && retryOn(lastError)) {
      if (retryDelayMs > 0) sleepMs(retryDelayMs * attempt);
      continue;
    }

    throw new SkillError(phase, code, message, lastError);
  }

  throw new SkillError(phase, code, lastError?.message || 'sonos command failed', lastError || { args });
}

export function resolveRoom(roomInput) {
  const raw = runSonos(['discover'], 'resolve-room', 'SONOS_DISCOVER_FAILED');
  const target = String(roomInput || '').toLowerCase();
  const exact = raw
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim())
    .find((name) => name && name.toLowerCase().includes(target));

  if (!exact) {
    throw new SkillError('resolve-room', 'ROOM_NOT_FOUND', `Room '${roomInput}' not found.`);
  }
  return exact;
}

export function parseStatus(raw) {
  const info = { raw };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    let match = trimmed.match(/^State:\s*(.+)$/i);
    if (match) info.state = match[1];
    match = trimmed.match(/^Track:\s*(.+)$/i);
    if (match) info.track = match[1];
    match = trimmed.match(/^Title:\s*(.+)$/i);
    if (match) info.title = match[1];
    match = trimmed.match(/^(Position|Time|Progress):\s*(.+)$/i);
    if (match) info.position = match[2];
    match = trimmed.match(/^Group:\s*(.+)$/i);
    if (match) info.group = match[1];
    match = trimmed.match(/^Coordinator:\s*(.+)$/i);
    if (match) info.coordinator = match[1];
  }
  return info;
}

export function getStatus(room) {
  return parseStatus(runSonos(['status', '--name', room], 'preflight', 'SONOS_STATUS_FAILED', {
    attempts: 3,
    retryDelayMs: 1200,
    retryOn: isRetryableStatusFailure,
  }));
}

export function getStatusJson(room) {
  const raw = runSonos(['status', '--name', room, '--format', 'json'], 'preflight', 'SONOS_STATUS_FAILED', {
    attempts: 3,
    retryDelayMs: 1200,
    retryOn: isRetryableStatusFailure,
  });
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SkillError('preflight', 'SONOS_STATUS_JSON_PARSE_FAILED', 'Failed to parse Sonos status JSON.', {
      room,
      raw,
      message: String(error?.message || error),
    });
  }
}

export function getQueue(room) {
  return runSonos(['queue', 'list', '--name', room], 'preflight', 'SONOS_QUEUE_FAILED', {
    attempts: 3,
    retryDelayMs: 1200,
    retryOn: isRetryableStatusFailure,
  });
}

export function getQueueJson(room, limit = 50) {
  const raw = runSonos(['queue', 'list', '--name', room, '--format', 'json', '--limit', String(limit)], 'preflight', 'SONOS_QUEUE_FAILED', {
    attempts: 3,
    retryDelayMs: 1200,
    retryOn: isRetryableStatusFailure,
  });
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SkillError('preflight', 'SONOS_QUEUE_JSON_PARSE_FAILED', 'Failed to parse Sonos queue JSON.', {
      room,
      raw,
      message: String(error?.message || error),
    });
  }
}

function isRetryableGroupStatusFailure(error) {
  const text = String([
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.signal,
  ].filter(Boolean).join('\n')).toLowerCase();

  return (
    text.includes('deadline exceeded') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('awaiting headers') ||
    text.includes('curl fallback failed') ||
    text.includes('zonegrouptopology') ||
    text.includes('econnreset') ||
    text.includes('connection reset') ||
    text.includes('no speakers found')
  );
}

function isRetryableStatusFailure(error) {
  const text = String([
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.signal,
  ].filter(Boolean).join('\n')).toLowerCase();

  return (
    text.includes('no speakers found') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('deadline exceeded') ||
    text.includes('connection reset')
  );
}

export function getGroupStatus() {
  return runSonos(['group', 'status'], 'preflight', 'SONOS_GROUP_STATUS_FAILED', {
    timeoutMs: 12000,
    attempts: 3,
    retryDelayMs: 1500,
    retryOn: isRetryableGroupStatusFailure,
  });
}

function parseGroupBlocks(groupStatus) {
  const lines = String(groupStatus || '').split('\n');
  const blocks = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (/^Group:/i.test(line.trim())) {
      if (current) blocks.push(current);
      current = {
        header: line.trim(),
        members: [],
      };
      continue;
    }

    if (current) {
      current.members.push(line);
    }
  }

  if (current) blocks.push(current);
  return blocks;
}

function roomIsGrouped(room, groupStatus) {
  const roomLower = String(room || '').toLowerCase();
  const blocks = parseGroupBlocks(groupStatus);

  for (const block of blocks) {
    const joined = [block.header, ...block.members].join('\n').toLowerCase();
    if (!joined.includes(roomLower)) continue;

    const memberCount = block.members.filter((line) => /\(/.test(line)).length;
    const plusCount = Number((block.header.match(/\+\s*(\d+)/)?.[1]) || 0);
    const coordinatorListsOthers = block.members.some((line) => !line.toLowerCase().includes(roomLower) && /\(/.test(line));

    if (memberCount > 1 || plusCount > 0 || coordinatorListsOthers) {
      return true;
    }
  }

  return false;
}

export function ensureSoloRoom(room, groupStatus) {
  if (!roomIsGrouped(room, groupStatus)) {
    return {
      changed: false,
      before: groupStatus,
      after: groupStatus,
    };
  }

  runSonos(['group', 'solo', '--name', room], 'group-normalize', 'GROUP_SOLO_FAILED');
  const updated = getGroupStatus();

  if (roomIsGrouped(room, updated)) {
    throw new SkillError(
      'group-normalize',
      'GROUP_SOLO_NOT_CONFIRMED',
      `Room '${room}' still appears grouped after solo.`,
      { beforeGroupStatus: groupStatus, groupStatus: updated }
    );
  }

  return {
    changed: true,
    before: groupStatus,
    after: updated,
  };
}

export function summarizeQueueDelta(before, after) {
  return {
    beforeCount: getQueueCount(before),
    afterCount: getQueueCount(after),
  };
}

export function applyControlSteps(room, controlSteps = []) {
  const results = [];

  for (const step of controlSteps) {
    if (step.kind === 'volume') {
      const safeValue = Math.max(0, Math.min(100, Number(step.value || 0)));
      runSonos(['volume', '--name', room, String(safeValue)], 'control', 'SONOS_VOLUME_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'volume', value: safeValue, status: status.state || null, title: status.title || null });
      continue;
    }

    if (step.kind === 'pause') {
      runSonos(['pause', '--name', room], 'control', 'SONOS_PAUSE_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'pause', status: status.state || null });
      continue;
    }

    if (step.kind === 'play') {
      runSonos(['play', '--name', room], 'control', 'SONOS_PLAY_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'play', status: status.state || null, title: status.title || null });
      continue;
    }

    if (step.kind === 'next') {
      runSonos(['next', '--name', room], 'control', 'SONOS_NEXT_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'next', status: status.state || null, title: status.title || null, track: status.track || null });
      continue;
    }

    if (step.kind === 'prev') {
      runSonos(['prev', '--name', room], 'control', 'SONOS_PREV_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'prev', status: status.state || null, title: status.title || null, track: status.track || null });
      continue;
    }

    if (step.kind === 'stop') {
      runSonos(['stop', '--name', room], 'control', 'SONOS_STOP_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'stop', status: status.state || null });
      continue;
    }

    if (step.kind === 'mute') {
      runSonos(['mute', '--name', room], 'control', 'SONOS_MUTE_FAILED');
      const status = getStatus(room);
      results.push({ kind: 'mute', status: status.state || null });
    }
  }

  return results;
}
