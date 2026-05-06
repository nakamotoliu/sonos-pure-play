import { spawnSync } from 'node:child_process';

import { SkillError, getQueueCount } from './normalize.mjs';

function normalizeRoomMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]+/g, '')
    .trim();
}

function isSubsequence(needle, haystack) {
  if (!needle) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index >= needle.length) return true;
  }
  return false;
}

export function parseDiscoverRooms(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim())
    .filter(Boolean);
}

function scoreRoomMatch(roomName, roomInput) {
  const candidate = normalizeRoomMatchText(roomName);
  const target = normalizeRoomMatchText(roomInput);
  if (!candidate || !target) return 0;
  if (candidate === target) return 100;
  if (candidate.includes(target)) return 80 + Math.min(19, target.length / Math.max(candidate.length, 1) * 19);
  if (target.includes(candidate)) return 70 + Math.min(9, candidate.length / Math.max(target.length, 1) * 9);
  if (isSubsequence(target, candidate)) return 45 + Math.min(14, target.length / Math.max(candidate.length, 1) * 14);
  return 0;
}

export function selectRoomMatch(roomNames, roomInput) {
  const target = normalizeRoomMatchText(roomInput);
  const exactMatches = roomNames.filter((name) => normalizeRoomMatchText(name) === target);
  if (exactMatches.length === 1) return { ok: true, room: exactMatches[0], score: 100, candidates: [{ name: exactMatches[0], score: 100 }] };

  const partialMatches = roomNames
    .filter((name) => normalizeRoomMatchText(name).includes(target))
    .map((name) => ({ name, score: scoreRoomMatch(name, roomInput) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  if (partialMatches.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: partialMatches };
  }

  const scored = roomNames
    .map((name) => ({ name, score: scoreRoomMatch(name, roomInput) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const best = scored[0] || null;
  if (!best || best.score < 45) return { ok: false, reason: 'not-found', candidates: scored };

  const tied = scored.filter((item) => Math.abs(item.score - best.score) < 0.0001);
  if (tied.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: tied };
  }

  return { ok: true, room: best.name, score: best.score, candidates: scored };
}

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

export function discoverRooms() {
  return parseDiscoverRooms(runSonos(['discover'], 'resolve-room', 'SONOS_DISCOVER_FAILED'));
}

export function resolveRoom(roomInput) {
  const rooms = discoverRooms();
  const match = selectRoomMatch(rooms, roomInput);

  if (!match.ok) {
    const code = match.reason === 'ambiguous' ? 'ROOM_AMBIGUOUS' : 'ROOM_NOT_FOUND';
    const suffix = match.candidates?.length
      ? ` Candidates: ${match.candidates.map((item) => item.name).join(', ')}`
      : '';
    throw new SkillError('resolve-room', code, `Room '${roomInput}' ${match.reason === 'ambiguous' ? 'is ambiguous' : 'not found'}.${suffix}`, {
      roomInput,
      candidates: match.candidates || [],
    });
  }
  return match.room;
}

export function parseStatus(raw) {
  const info = { raw };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    let match = trimmed.match(/^URI:\s*(.+)$/i);
    if (match) info.uri = match[1];
    match = trimmed.match(/^State:\s*(.+)$/i);
    if (match) info.state = match[1];
    match = trimmed.match(/^Track:\s*(.+)$/i);
    if (match) info.track = match[1];
    match = trimmed.match(/^Title:\s*(.+)$/i);
    if (match) info.title = match[1];
    match = trimmed.match(/^Artist:\s*(.+)$/i);
    if (match) info.artist = match[1];
    match = trimmed.match(/^Album:\s*(.+)$/i);
    if (match) info.album = match[1];
    match = trimmed.match(/^(Position|Time|Progress):\s*(.+)$/i);
    if (match) info.position = match[2];
    match = trimmed.match(/^Volume:\s*(.+)$/i);
    if (match) info.volume = match[1];
    match = trimmed.match(/^Mute:\s*(.+)$/i);
    if (match) info.mute = match[1];
    match = trimmed.match(/^Group:\s*(.+)$/i);
    if (match) info.group = match[1];
    match = trimmed.match(/^Coordinator:\s*(.+)$/i);
    if (match) info.coordinator = match[1];
  }
  return info;
}

export function getStatus(room) {
  return withResolvedRoomRetry(room, (resolvedRoom) => {
    const status = parseStatus(runSonos(['status', '--name', resolvedRoom], 'preflight', 'SONOS_STATUS_FAILED', {
      attempts: 3,
      retryDelayMs: 1200,
      retryOn: isRetryableStatusFailure,
    }));
    if (resolvedRoom !== room) status.resolvedRoom = resolvedRoom;
    return status;
  });
}

function statusState(status = {}) {
  return String(status.state || '').trim().toUpperCase();
}

function statusFingerprint(status = {}) {
  return [status.uri, status.title, status.artist, status.album, status.track]
    .map((value) => String(value || '').trim())
    .join('|');
}

function roomKey(room) {
  return normalizeRoomMatchText(room);
}

function statusMatchesText(status = {}, text = '') {
  const needle = normalizeRoomMatchText(text);
  if (!needle) return false;
  const haystack = normalizeRoomMatchText([
    status.title,
    status.artist,
    status.album,
    status.uri,
  ].filter(Boolean).join(' '));
  return Boolean(haystack && haystack.includes(needle));
}

export function collectRoomStatuses(rooms = discoverRooms()) {
  return rooms.map((room) => {
    try {
      return { room, ok: true, status: getStatus(room) };
    } catch (error) {
      return {
        room,
        ok: false,
        error: {
          phase: error?.phase || null,
          code: error?.code || null,
          message: String(error?.message || error),
        },
      };
    }
  });
}

export function detectNonTargetPlaybackLeaks({ before = [], after = [], targetRoom, request = '', selectedContent = '' } = {}) {
  const targetKey = roomKey(targetRoom);
  const beforeByRoom = new Map((Array.isArray(before) ? before : []).map((entry) => [roomKey(entry.room), entry]));

  return (Array.isArray(after) ? after : [])
    .filter((entry) => roomKey(entry.room) !== targetKey)
    .map((entry) => {
      const previous = beforeByRoom.get(roomKey(entry.room)) || null;
      const status = entry.status || {};
      const previousStatus = previous?.status || {};
      const nowPlaying = statusState(status) === 'PLAYING';
      const wasPlaying = statusState(previousStatus) === 'PLAYING';
      const changed = statusFingerprint(status) !== statusFingerprint(previousStatus);
      const matchedSelected = statusMatchesText(status, selectedContent);
      const matchedRequest = statusMatchesText(status, request);
      const leaked = nowPlaying && (!wasPlaying || changed || matchedSelected || matchedRequest);
      return {
        room: entry.room,
        leaked,
        reason: leaked
          ? (!wasPlaying ? 'non-target-started-playing' : changed ? 'non-target-playback-changed' : matchedSelected ? 'non-target-matches-selected-content' : 'non-target-matches-request')
          : null,
        before: previousStatus,
        after: status,
      };
    })
    .filter((entry) => entry.leaked);
}

export function pauseRoom(room) {
  const resolvedRoom = resolveRoom(room);
  runSonos(['pause', '--name', resolvedRoom], 'non-target-guard', 'SONOS_PAUSE_NON_TARGET_FAILED');
  return getStatus(resolvedRoom);
}

export function getStatusJson(room) {
  return withResolvedRoomRetry(room, (resolvedRoom) => {
    const raw = runSonos(['status', '--name', resolvedRoom, '--format', 'json'], 'preflight', 'SONOS_STATUS_FAILED', {
      attempts: 3,
      retryDelayMs: 1200,
      retryOn: isRetryableStatusFailure,
    });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SkillError('preflight', 'SONOS_STATUS_JSON_PARSE_FAILED', 'Failed to parse Sonos status JSON.', {
        room: resolvedRoom,
        raw,
        message: String(error?.message || error),
      });
    }
    if (resolvedRoom !== room && parsed && typeof parsed === 'object') parsed.resolvedRoom = resolvedRoom;
    return parsed;
  });
}

function isRoomNameResolutionFailure(error) {
  const text = String([
    error?.message,
    error?.data?.message,
    error?.data?.stderr,
    error?.data?.stdout,
  ].filter(Boolean).join('\n')).toLowerCase();

  return (
    text.includes('speaker name not found') ||
    text.includes('not found in topology') ||
    text.includes('room not found')
  );
}

function withResolvedRoomRetry(room, operation) {
  try {
    return operation(room);
  } catch (error) {
    if (!isRoomNameResolutionFailure(error)) throw error;

    const resolvedRoom = resolveRoom(room);
    if (!resolvedRoom || normalizeRoomMatchText(resolvedRoom) === normalizeRoomMatchText(room)) throw error;
    return operation(resolvedRoom);
  }
}

export function getQueue(room) {
  return withResolvedRoomRetry(room, (resolvedRoom) => runSonos(['queue', 'list', '--name', resolvedRoom], 'preflight', 'SONOS_QUEUE_FAILED', {
    attempts: 3,
    retryDelayMs: 1200,
    retryOn: isRetryableStatusFailure,
  }));
}

export function getQueueJson(room, limit = 50) {
  return withResolvedRoomRetry(room, (resolvedRoom) => {
    const raw = runSonos(['queue', 'list', '--name', resolvedRoom, '--format', 'json', '--limit', String(limit)], 'preflight', 'SONOS_QUEUE_FAILED', {
      attempts: 3,
      retryDelayMs: 1200,
      retryOn: isRetryableStatusFailure,
    });
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new SkillError('preflight', 'SONOS_QUEUE_JSON_PARSE_FAILED', 'Failed to parse Sonos queue JSON.', {
        room: resolvedRoom,
        raw,
        message: String(error?.message || error),
      });
    }
  });
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
  const resolvedRoom = resolveRoom(room);
  const results = [];

  for (const step of controlSteps) {
    if (step.kind === 'volume') {
      const safeValue = Math.max(0, Math.min(100, Number(step.value || 0)));
      runSonos(['volume', '--name', resolvedRoom, String(safeValue)], 'control', 'SONOS_VOLUME_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'volume', value: safeValue, status: status.state || null, title: status.title || null });
      continue;
    }

    if (step.kind === 'pause') {
      runSonos(['pause', '--name', resolvedRoom], 'control', 'SONOS_PAUSE_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'pause', status: status.state || null });
      continue;
    }

    if (step.kind === 'play') {
      runSonos(['play', '--name', resolvedRoom], 'control', 'SONOS_PLAY_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'play', status: status.state || null, title: status.title || null });
      continue;
    }

    if (step.kind === 'next') {
      runSonos(['next', '--name', resolvedRoom], 'control', 'SONOS_NEXT_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'next', status: status.state || null, title: status.title || null, track: status.track || null });
      continue;
    }

    if (step.kind === 'prev') {
      runSonos(['prev', '--name', resolvedRoom], 'control', 'SONOS_PREV_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'prev', status: status.state || null, title: status.title || null, track: status.track || null });
      continue;
    }

    if (step.kind === 'stop') {
      runSonos(['stop', '--name', resolvedRoom], 'control', 'SONOS_STOP_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'stop', status: status.state || null });
      continue;
    }

    if (step.kind === 'mute') {
      runSonos(['mute', '--name', resolvedRoom], 'control', 'SONOS_MUTE_FAILED');
      const status = getStatus(resolvedRoom);
      results.push({ kind: 'mute', status: status.state || null });
    }
  }

  return results;
}
