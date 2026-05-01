import test from 'node:test';
import assert from 'node:assert/strict';

const verifyInitialRoomSyncRead = (result) => {
  if (result?.code === 'SONOS_WEB_PROFILE_LOGGED_OUT' || result?.code === 'LOGIN_CHALLENGE_REQUIRED' || result?.loginBlocked || result?.challengeRequired) {
    throw new Error(result?.code || 'SONOS_WEB_PROFILE_LOGGED_OUT');
  }
  return {
    ok: Boolean(result?.ok === false ? false : true),
    result,
    warning: result?.roomVisible || result?.roomCardFound ? null : 'room-not-visible-on-current-page',
  };
};

const verifyFinalRoomSyncRead = (result) => ({ ok: Boolean(result?.activeRoomConfirmed), result });

test('initial room sync read may continue when current page lacks room card', () => {
  const result = verifyInitialRoomSyncRead({ activeRoomConfirmed: false, roomVisible: false, roomCardFound: false });
  assert.equal(result.ok, true);
  assert.equal(result.warning, 'room-not-visible-on-current-page');
});

test('initial room sync read still fails closed for login or challenge states', () => {
  assert.throws(() => verifyInitialRoomSyncRead({ loginBlocked: true }), /SONOS_WEB_PROFILE_LOGGED_OUT/);
  assert.throws(() => verifyInitialRoomSyncRead({ code: 'LOGIN_CHALLENGE_REQUIRED' }), /LOGIN_CHALLENGE_REQUIRED/);
});

test('final room sync requires confirmed active target room, not just a visible room card', () => {
  assert.equal(verifyFinalRoomSyncRead({ activeRoomConfirmed: false, roomCardFound: true }).ok, false);
  assert.equal(verifyFinalRoomSyncRead({ activeRoomConfirmed: true, roomCardFound: true }).ok, true);
});
