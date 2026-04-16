#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const planPath = path.join(__dirname, '..', 'data', 'jason-wakeup-weekly-plan.json');
function weekdayKey(now = new Date()) {
  const day = now.getDay();
  return ({ 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri' })[day] || null;
}

const key = weekdayKey();
if (!key) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: 'not-weekday' }));
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const slot = raw?.days?.[key];
if (!slot?.query) {
  console.error(JSON.stringify({ ok: false, code: 'MISSING_WEEKLY_PLAN_SLOT', key, planPath }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, phase: 'weekly-plan', weekOf: raw.weekOf, key, artist: slot.artist, query: slot.query }));
console.error(JSON.stringify({
  ok: false,
  code: 'RUNNER_REMOVED',
  message: 'scripts/run.mjs has been removed. Execute sonos-pure-play through the skill flow instead of the old script runner.',
  query: slot.query,
  room: '客厅',
  mode: 'replace-first',
}));
process.exit(1);
