import { PurePlayBrowserRunner } from './browser-runner.mjs';

const rooms = process.argv.slice(2);
if (rooms.length < 2) {
  console.error('Usage: node scripts/test-room-switch.mjs <roomA> <roomB> [rounds]');
  process.exit(2);
}

const requestedRounds = Number.parseInt(rooms[2] || '1', 10);
const rounds = Number.isFinite(requestedRounds) && requestedRounds > 0 ? requestedRounds : 1;
const [roomA, roomB] = rooms;

const logs = [];
const logger = (entry) => {
  logs.push(entry);
  console.log(JSON.stringify(entry));
};

const runner = new PurePlayBrowserRunner({ logger });
const targetId = runner.ensureSonosTab();

function detectActiveRoom() {
  const states = [roomA, roomB].map((room) => runner.readRoomSyncState(targetId, room));
  const active = states.map((state) => ({
    room: state?.targetRoom,
    hasActivate: Array.isArray(state?.roomCardButtons) && state.roomCardButtons.includes(`将${state?.targetRoom}设置为有效`),
    hasControls: Array.isArray(state?.activeControls) && state.activeControls.length > 0,
    activeRoomConfirmed: Boolean(state?.activeRoomConfirmed),
    roomCardFound: Boolean(state?.roomCardFound),
    buttons: state?.roomCardButtons || [],
    nowPlayingRoom: state?.nowPlayingRoom || null,
  }));

  const current = active.find((entry) => entry.activeRoomConfirmed)?.room
    || active.find((entry) => entry.hasControls && !entry.hasActivate)?.room
    || null;

  return { active, current };
}

function syncActiveRoom(room) {
  const before = runner.readRoomSyncState(targetId, room);
  logger({ phase: 'room-switch-test', event: 'before-sync', room, before });
  if (before?.activeRoomConfirmed) {
    return { room, skipped: true, before, after: before };
  }
  const click = runner.clickRoomActivate(targetId, room);
  logger({ phase: 'room-switch-test', event: 'click-sync', room, click });
  runner.waitMs(500);
  const after = runner.readRoomSyncState(targetId, room);
  logger({ phase: 'room-switch-test', event: 'after-sync', room, after });
  return { room, skipped: false, before, click, after };
}

for (let round = 1; round <= rounds; round += 1) {
  const detected = detectActiveRoom();
  console.log(JSON.stringify({ phase: 'room-switch-test', event: 'detected-active-room', round, detected }));
  const current = detected?.current;
  const order = current === roomA ? [roomB, roomA] : current === roomB ? [roomA, roomB] : [roomA, roomB];

  for (const room of order) {
    console.log(JSON.stringify({ phase: 'room-switch-test', event: 'begin', round, room, currentBefore: detectActiveRoom() }));
    const result = syncActiveRoom(room);
    console.log(JSON.stringify({ phase: 'room-switch-test', event: 'confirmed', round, room, result, currentAfter: detectActiveRoom() }));
  }
}

console.log(JSON.stringify({ phase: 'room-switch-test', event: 'done', rooms: [roomA, roomB], rounds }));
