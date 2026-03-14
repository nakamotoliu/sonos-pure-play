import { spawnSync } from 'node:child_process';

import { SkillError, getQueueCount } from './normalize.mjs';

function runSonos(args, phase, code) {
  const result = spawnSync('sonos', args, { encoding: 'utf8' });
  if (result.error) {
    throw new SkillError(phase, code, result.error.message, { args });
  }
  if (result.status !== 0) {
    throw new SkillError(phase, code, (result.stderr || 'sonos command failed').trim(), { args, exitCode: result.status });
  }
  return result.stdout.trim();
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
  return parseStatus(runSonos(['status', '--name', room], 'preflight', 'SONOS_STATUS_FAILED'));
}

export function getQueue(room) {
  return runSonos(['queue', 'list', '--name', room], 'preflight', 'SONOS_QUEUE_FAILED');
}

export function getGroupStatus() {
  return runSonos(['group', 'status'], 'preflight', 'SONOS_GROUP_STATUS_FAILED');
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
