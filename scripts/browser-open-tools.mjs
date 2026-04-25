import { SkillError } from './normalize.mjs';
import { SEARCH_URL, SONOS_HOST } from './selectors.mjs';

export function tabs(runner) {
  const resident = runner.requestBrowser?.({ method: 'GET', path: '/tabs' });
  if (resident) return resident.tabs || [];
  return runner.oc(['tabs']).tabs || [];
}

export function focus(runner, targetId) {
  const resident = runner.requestBrowser?.({ method: 'POST', path: '/tabs/focus', body: { targetId } }, { timeoutMs: 20000 });
  if (resident) return resident;
  runner.oc(['focus', targetId], { parseJson: false });
}

export function close(runner, targetId) {
  const resident = runner.requestBrowser?.({ method: 'DELETE', path: `/tabs/${encodeURIComponent(targetId)}` }, { timeoutMs: 20000 });
  if (resident) return resident;
  runner.oc(['close', targetId], { parseJson: false });
}

export function waitMs(runner, ms) {
  const resident = runner.actBrowser?.({ kind: 'wait', timeMs: Number(ms) || 0 }, { timeoutMs: Math.max(Number(ms) || 0, 1000) + 5000 });
  if (resident) return resident;
  runner.oc(['wait', '--time', String(ms)], { parseJson: false });
}

export function waitForLoad(runner, targetId) {
  const resident = runner.actBrowser?.({ kind: 'wait', targetId, loadState: 'domcontentloaded', timeoutMs: 30000 }, { timeoutMs: 35000 });
  if (resident) return resident;
  runner.oc(['wait', '--target-id', targetId, '--load', 'domcontentloaded', '--timeout-ms', '30000'], { parseJson: false });
}

export function navigate(runner, targetId, url) {
  const resident = runner.requestBrowser?.({ method: 'POST', path: '/navigate', body: { url, targetId } }, { timeoutMs: 20000 });
  if (resident) return resident;
  runner.oc(['navigate', url, '--target-id', targetId], { parseJson: false });
}

export function start(runner) {
  runner.oc(['start'], { parseJson: false });
}

export function ensureSonosTab(runner) {
  runner.log({ event: 'ensure-sonos-tab-start', profile: runner.profile, interactionMode: runner.interactionMode() });
  start(runner);
  runner.log({ event: 'ensure-sonos-tab-after-start' });

  let sonosTabs = tabs(runner).filter((entry) => String(entry.url || '').includes(SONOS_HOST));
  runner.log({ event: 'ensure-sonos-tab-after-tabs', count: sonosTabs.length, targetIds: sonosTabs.map((entry) => entry?.targetId).filter(Boolean) });

  if (sonosTabs.length > 1) {
    const keepTab = sonosTabs[sonosTabs.length - 1];
    const closeTabs = sonosTabs.slice(0, -1);
    const closedTargetIds = [];

    for (const entry of closeTabs) {
      if (!entry?.targetId) continue;
      close(runner, entry.targetId);
      closedTargetIds.push(entry.targetId);
      runner.log({ event: 'tab-closed', targetId: entry.targetId, url: entry.url || null });
    }

    runner.log({
      event: 'tab-hygiene',
      foundSonosTabs: sonosTabs.length,
      keptTargetId: keepTab?.targetId || null,
      keptUrl: keepTab?.url || null,
      closedTargetIds,
    });

    waitMs(runner, 250);
    sonosTabs = tabs(runner).filter((entry) => String(entry.url || '').includes(SONOS_HOST));
  }

  let tab = sonosTabs[sonosTabs.length - 1];

  if (!tab) {
    runner.log({ event: 'ensure-sonos-tab-open-search-url', url: SEARCH_URL });
    runner.oc(['open', SEARCH_URL], { parseJson: false });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      waitMs(runner, 250);
      sonosTabs = tabs(runner).filter((entry) => String(entry.url || '').includes(SONOS_HOST));
      tab = sonosTabs[sonosTabs.length - 1];
      runner.log({ event: 'ensure-sonos-tab-poll-open', count: sonosTabs.length, targetIds: sonosTabs.map((entry) => entry?.targetId).filter(Boolean) });
      if (tab?.targetId) break;
    }
  }

  if (!tab?.targetId) {
    throw new SkillError(
      'browser-open',
      'SONOS_WEB_NOT_READY',
      'Unable to find or open the Sonos Web App in the configured OpenClaw browser profile.'
    );
  }

  const tabUrl = String(tab.url || '');
  if (runner.requiresForeground()) {
    runner.log({ event: 'ensure-sonos-tab-before-focus', targetId: tab.targetId, url: tabUrl || null });
    focus(runner, tab.targetId);
    runner.log({ event: 'ensure-sonos-tab-after-focus', targetId: tab.targetId });
  } else {
    runner.log({
      event: 'ensure-sonos-tab-skip-focus',
      targetId: tab.targetId,
      url: tabUrl || null,
      interactionMode: runner.interactionMode(),
    });
  }

  if (tabUrl.includes('/search')) {
    waitMs(runner, 80);
    runner.ensureLoggedInOrRecover(tab.targetId);
    runner.log({
      event: 'tab-ready-fast-path',
      targetId: tab.targetId,
      url: tabUrl,
      foregroundRequired: runner.requiresForeground(),
      interactionMode: runner.interactionMode(),
      profile: runner.profile,
      preservedExistingPage: true,
    });
    return tab.targetId;
  }

  waitMs(runner, 80);
  runner.log({ event: 'ensure-sonos-tab-before-load-wait', targetId: tab.targetId });
  waitForLoad(runner, tab.targetId);
  runner.log({ event: 'ensure-sonos-tab-after-load-wait', targetId: tab.targetId });
  waitMs(runner, 80);
  runner.ensureLoggedInOrRecover(tab.targetId);
  runner.log({
    event: 'tab-ready',
    targetId: tab.targetId,
    url: tabUrl || null,
    foregroundRequired: runner.requiresForeground(),
    interactionMode: runner.interactionMode(),
    profile: runner.profile,
    preservedExistingPage: true,
  });
  return tab.targetId;
}
