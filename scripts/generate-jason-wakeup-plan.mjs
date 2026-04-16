#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const historyPath = path.join(dataDir, 'sonos-playback-history.json');
const planPath = path.join(dataDir, 'jason-wakeup-weekly-plan.json');

const catalog = [
  { artist: '周杰伦', query: '周杰伦 精选', tags: ['mandopop', 'male', 'steady'] },
  { artist: '陶喆', query: '陶喆 精选', tags: ['mandopop', 'male', 'groove'] },
  { artist: '陈奕迅', query: '陈奕迅 精选', tags: ['mandopop', 'male', 'steady'] },
  { artist: '王力宏', query: '王力宏 精选', tags: ['mandopop', 'male', 'bright'] },
  { artist: '林俊杰', query: '林俊杰 精选', tags: ['mandopop', 'male', 'bright'] },
  { artist: '李荣浩', query: '李荣浩 精选', tags: ['mandopop', 'male', 'steady'] },
  { artist: 'Bruno Mars', query: 'Bruno Mars playlist', tags: ['english', 'male', 'groove'] },
  { artist: 'John Mayer', query: 'John Mayer playlist', tags: ['english', 'male', 'steady'] },
  { artist: 'Jason Mraz', query: 'Jason Mraz playlist', tags: ['english', 'male', 'bright'] },
  { artist: 'Michael Bublé', query: 'Michael Bublé playlist', tags: ['english', 'male', 'soft'] }
];

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function inferArtist(entry) {
  const text = `${entry?.originalIntent || ''} ${entry?.queryUsed || ''} ${entry?.selectedTitle || ''} ${entry?.finalTitle || ''}`;
  for (const item of catalog) {
    if (text.toLowerCase().includes(item.artist.toLowerCase())) return item.artist;
  }
  return null;
}

function mondayOfNextWeek(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay();
  const offsetToNextMonday = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + offsetToNextMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function pickPlan(history) {
  const recent = [...history]
    .map((entry) => ({ ...entry, inferredArtist: inferArtist(entry) }))
    .filter((entry) => entry.inferredArtist)
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  const recentArtists = [];
  for (const entry of recent) {
    if (!recentArtists.includes(entry.inferredArtist)) recentArtists.push(entry.inferredArtist);
    if (recentArtists.length >= 5) break;
  }

  const available = catalog.filter((item) => !recentArtists.includes(item.artist));
  const fallback = catalog.filter((item) => recentArtists.includes(item.artist));
  const ordered = [...available, ...fallback];

  const chosen = [];
  const usedTags = [];
  for (const item of ordered) {
    if (chosen.length >= 5) break;
    const previous = chosen[chosen.length - 1];
    if (previous && previous.tags.some((tag) => item.tags.includes(tag)) && chosen.length < ordered.length - 1) {
      const alt = ordered.find((candidate) => !chosen.includes(candidate) && !previous.tags.some((tag) => candidate.tags.includes(tag)));
      if (alt) {
        chosen.push(alt);
        continue;
      }
    }
    chosen.push(item);
    usedTags.push(...item.tags);
  }

  while (chosen.length < 5) {
    const next = ordered.find((item) => !chosen.includes(item));
    if (!next) break;
    chosen.push(next);
  }

  return {
    mon: { artist: chosen[0].artist, query: chosen[0].query },
    tue: { artist: chosen[1].artist, query: chosen[1].query },
    wed: { artist: chosen[2].artist, query: chosen[2].query },
    thu: { artist: chosen[3].artist, query: chosen[3].query },
    fri: { artist: chosen[4].artist, query: chosen[4].query },
    recentArtists,
  };
}

const history = loadHistory();
const weekOf = mondayOfNextWeek();
const plan = pickPlan(history);
const output = {
  version: 1,
  updatedAt: new Date().toISOString(),
  weekOf: weekOf.toISOString().slice(0, 10),
  basis: {
    recentArtistsAvoided: plan.recentArtists,
    sourceHistoryCount: history.length,
    note: 'Jason Wakeup weekly plan generated from recent playback history with anti-repeat preference.'
  },
  days: {
    mon: plan.mon,
    tue: plan.tue,
    wed: plan.wed,
    thu: plan.thu,
    fri: plan.fri
  }
};

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(planPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, planPath, weekOf: output.weekOf, days: output.days }, null, 2));
