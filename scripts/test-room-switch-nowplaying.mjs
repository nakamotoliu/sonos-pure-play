import { PurePlayBrowserRunner } from './browser-runner.mjs';

const [roomA, roomB, roundsArg = '6'] = process.argv.slice(2);
if (!roomA || !roomB) {
  console.error('Usage: node skills/sonos-pure-play/scripts/test-room-switch-nowplaying.mjs <roomA> <roomB> [rounds]');
  process.exit(2);
}

const rounds = Number(roundsArg) || 6;
const TOTAL_TIMEOUT_MS = Number(process.env.SONOS_ROOM_SWITCH_TOTAL_TIMEOUT_MS || 180000);
const browserProfile = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless';
const runner = new PurePlayBrowserRunner({
  profile: browserProfile,
  logger: (entry) => console.log(JSON.stringify(entry)),
});
const startedAt = Date.now();
const results = [];

function remainingMs() {
  return Math.max(0, TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
}

function emitSummary(reason = null, extra = {}) {
  console.log(JSON.stringify({
    phase: 'room-switch-nowplaying-test',
    event: 'summary',
    rounds,
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    elapsedMs: Date.now() - startedAt,
    reason,
    results,
    ...extra,
  }, null, 2));
}

function finish(code, reason = null, extra = {}) {
  emitSummary(reason, extra);
  process.exit(code);
}

process.on('SIGTERM', () => finish(143, 'sigterm'));
process.on('SIGINT', () => finish(130, 'sigint'));

console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'profile', browserProfile, totalTimeoutMs: TOTAL_TIMEOUT_MS }));
const targetId = runner.ensureSonosTab();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNowPlayingRoom() {
  const result = runner.evaluate(
    targetId,
    `() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const section = [...document.querySelectorAll('section,[role="region"],div')]
        .filter(visible)
        .find((el) => (el.getAttribute('aria-label') || '') === '正在播放' || /^正在播放$/.test(textOf(el)));
      if (!section) {
        return { found: false, room: null, text: null };
      }
      const scope = section.parentElement || section;
      const text = textOf(scope);
      const knownRooms = ['${roomA.replace(/'/g, "\\'")}', '${roomB.replace(/'/g, "\\'")}'];
      const room = knownRooms.find((name) => text.includes(name)) || null;
      return { found: true, room, text: text.slice(0, 400) };
    }`
  );
  return result?.result || result;
}

async function waitForNowPlaying(room, timeoutMs = 8000) {
  const started = Date.now();
  let last = null;
  const budgetMs = Math.min(timeoutMs, remainingMs());
  while (Date.now() - started < budgetMs && remainingMs() > 0) {
    last = readNowPlayingRoom();
    if (last?.room === room) return { ok: true, state: last };
    await sleep(500);
  }
  return {
    ok: false,
    state: last,
    reason: remainingMs() <= 0 ? 'total-timeout' : 'room-switch-not-confirmed',
  };
}

for (let i = 0; i < rounds; i += 1) {
  if (remainingMs() <= 0) finish(1, 'total-timeout-before-round', { failedRound: i + 1 });
  const targetRoom = i % 2 === 0 ? roomA : roomB;
  const before = readNowPlayingRoom();
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'before', round: i + 1, targetRoom, before, remainingMs: remainingMs() }));
  const clickResult = runner.clickRoomActivate(targetId, targetRoom);
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'click', round: i + 1, targetRoom, clickResult, remainingMs: remainingMs() }));
  const after = await waitForNowPlaying(targetRoom, 10000);
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'after', round: i + 1, targetRoom, after, remainingMs: remainingMs() }));
  results.push({ round: i + 1, targetRoom, before, clickResult, after, success: !!after?.ok });
  if (!after?.ok && after?.reason === 'total-timeout') finish(1, 'total-timeout-after-click', { failedRound: i + 1 });
}

finish(results.every((item) => item.success) ? 0 : 1, results.every((item) => item.success) ? 'completed' : 'room-switch-failed');
