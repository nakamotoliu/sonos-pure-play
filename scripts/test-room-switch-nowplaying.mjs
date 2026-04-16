import { PurePlayBrowserRunner } from './browser-runner.mjs';

const [roomA, roomB, roundsArg = '6'] = process.argv.slice(2);
if (!roomA || !roomB) {
  console.error('Usage: node skills/sonos-pure-play/scripts/test-room-switch-nowplaying.mjs <roomA> <roomB> [rounds]');
  process.exit(2);
}

const rounds = Number(roundsArg) || 6;
const browserProfile = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw';
const runner = new PurePlayBrowserRunner({
  profile: browserProfile,
  logger: (entry) => console.log(JSON.stringify(entry)),
});
console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'profile', browserProfile }));
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
  while (Date.now() - started < timeoutMs) {
    last = readNowPlayingRoom();
    if (last?.room === room) return { ok: true, state: last };
    await sleep(500);
  }
  return { ok: false, state: last };
}

const results = [];
for (let i = 0; i < rounds; i += 1) {
  const targetRoom = i % 2 === 0 ? roomA : roomB;
  const before = readNowPlayingRoom();
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'before', round: i + 1, targetRoom, before }));
  const clickResult = runner.clickRoomActivate(targetId, targetRoom);
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'click', round: i + 1, targetRoom, clickResult }));
  const after = await waitForNowPlaying(targetRoom, 10000);
  console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'after', round: i + 1, targetRoom, after }));
  results.push({ round: i + 1, targetRoom, before, clickResult, after, success: !!after?.ok });
}

console.log(JSON.stringify({ phase: 'room-switch-nowplaying-test', event: 'summary', rounds, results }, null, 2));