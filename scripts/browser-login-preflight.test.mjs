import test from 'node:test';
import assert from 'node:assert/strict';

import { isSonosLoginState, PurePlayBrowserRunner } from './browser-runner.mjs';

function runnerWithState(state) {
  const runner = Object.create(PurePlayBrowserRunner.prototype);
  runner.profile = 'openclaw-headless';
  runner.readPageState = () => state;
  return runner;
}

test('detects Sonos login and identity-provider URLs as logged-out preflight states', () => {
  assert.equal(isSonosLoginState({ url: 'https://login.sonos.com/' }), true);
  assert.equal(isSonosLoginState({ url: 'https://idassets.sonos.com/welcome' }), true);
  assert.equal(isSonosLoginState({ url: 'https://play.sonos.com/zh-cn/web-app', loginBlocked: true }), true);
  assert.equal(isSonosLoginState({ url: 'https://play.sonos.com/zh-cn/web-app', challengeRequired: true }), true);
  assert.equal(isSonosLoginState({ url: 'https://play.sonos.com/zh-cn/search', loginBlocked: false }), false);
});

test('assertLoggedIn stops early with a profile-login error on Sonos login page', () => {
  const runner = runnerWithState({ url: 'https://login.sonos.com/', title: 'Sonos', loginBlocked: false });

  assert.throws(
    () => runner.assertLoggedIn('target-1'),
    (error) => {
      assert.equal(error.phase, 'preflight');
      assert.equal(error.code, 'SONOS_WEB_PROFILE_LOGGED_OUT');
      assert.equal(error.data.profile, 'openclaw-headless');
      assert.equal(error.data.url, 'https://login.sonos.com/');
      return true;
    }
  );
});

test('assertLoggedIn reports challenges distinctly', () => {
  const runner = runnerWithState({ url: 'https://login.sonos.com/challenge', challengeRequired: true });

  assert.throws(
    () => runner.assertLoggedIn('target-1'),
    (error) => {
      assert.equal(error.phase, 'preflight');
      assert.equal(error.code, 'LOGIN_CHALLENGE_REQUIRED');
      return true;
    }
  );
});

test('assertLoggedIn accepts a usable Sonos app page', () => {
  const runner = runnerWithState({ url: 'https://play.sonos.com/zh-cn/search', loginBlocked: false, challengeRequired: false });
  assert.deepEqual(runner.assertLoggedIn('target-1'), {
    ok: true,
    state: { url: 'https://play.sonos.com/zh-cn/search', loginBlocked: false, challengeRequired: false },
  });
});
