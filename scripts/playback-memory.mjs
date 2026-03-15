import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText, normalizeWhitespace } from './normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY_PATH = path.join(__dirname, '..', 'data', 'sonos-playback-history.json');
const HISTORY_LIMIT = 400;

function getHistoryPath() {
  return process.env.SONOS_PLAYBACK_HISTORY_PATH || DEFAULT_HISTORY_PATH;
}

export function loadPlaybackHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

export function scoreHistoryPenalty({ candidate, history, now, query }) {
  const entries = Array.isArray(history) ? history : [];
  const targetTitle = normalizeText(candidate.title);
  const targetType = normalizeText(candidate.type);
  const normalizedQuery = normalizeText(query);
  const currentTs = Date.parse(now) || Date.now();
  const reasons = [];
  let total = 0;

  for (const entry of entries) {
    if (normalizeText(entry.selectedTitle) !== targetTitle || normalizeText(entry.selectedType) !== targetType) {
      continue;
    }

    const ageMs = currentTs - (Date.parse(entry.ts) || 0);
    if (ageMs <= 24 * 60 * 60 * 1000) {
      total -= 100;
      reasons.push('same-title-within-24h');
    } else if (ageMs <= 3 * 24 * 60 * 60 * 1000) {
      total -= 40;
      reasons.push('same-title-within-3d');
    } else if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
      total -= 15;
      reasons.push('same-title-within-7d');
    }

    if (normalizedQuery && normalizeText(entry.queryUsed) === normalizedQuery && ageMs <= 24 * 60 * 60 * 1000) {
      total -= 20;
      reasons.push('same-query-within-24h');
    }
  }

  return { total, reasons };
}

export function recordSuccessfulPlayback({
  room,
  originalIntent,
  queryUsed,
  selectedTitle,
  selectedType,
  actionName,
  finalTitle,
  finalTrack,
  verify = 'success',
}) {
  const history = loadPlaybackHistory();
  const entry = {
    ts: new Date().toISOString(),
    room: normalizeWhitespace(room),
    originalIntent: normalizeWhitespace(originalIntent),
    queryUsed: normalizeWhitespace(queryUsed),
    selectedTitle: normalizeWhitespace(selectedTitle),
    selectedType: normalizeWhitespace(selectedType),
    actionName: normalizeWhitespace(actionName),
    finalTitle: normalizeWhitespace(finalTitle),
    finalTrack: normalizeWhitespace(finalTrack),
    verify,
  };

  const historyPath = getHistoryPath();
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  const next = [...history, entry].slice(-HISTORY_LIMIT);
  fs.writeFileSync(historyPath, JSON.stringify({ version: 1, entries: next }, null, 2) + '\n', 'utf8');
  return entry;
}

export const HISTORY_PATH = DEFAULT_HISTORY_PATH;
