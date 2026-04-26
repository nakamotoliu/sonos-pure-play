import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillError } from './normalize.mjs';
import { SEARCH_URL, SONOS_HOST } from './selectors.mjs';

const TAB_HINT_FILE = path.join(os.homedir(), '.openclaw', 'cache', 'sonos-tab-hint.json');
const ENABLE_TABS_BEFORE_START_PROBE = process.env.SONOS_ENABLE_TABS_BEFORE_START_PROBE === '1';
const ENABLE_TABS_AFTER_START_PROBE = process.env.SONOS_ENABLE_TABS_AFTER_START_PROBE === '1';
const TABS_BEFORE_START_SOFT_TIMEOUT_MS = Number(process.env.SONOS_TABS_BEFORE_START_SOFT_TIMEOUT_MS || 2500);
const TABS_AFTER_START_SOFT_TIMEOUT_MS = Number(process.env.SONOS_TABS_AFTER_START_SOFT_TIMEOUT_MS || 4000);

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!duration) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function runEnsureStage(runner, stage, fn, extra = {}) {
  const startedAt = Date.now();
  runner.log({ event: 'ensure-sonos-tab-stage-start', stage, ...extra });
  try {
    const result = fn();
    runner.log({
      event: 'ensure-sonos-tab-stage-ok',
      stage,
      durationMs: Date.now() - startedAt,
      ...extra,
    });
    return result;
  } catch (error) {
    runner.log({
      event: 'ensure-sonos-tab-stage-failed',
      stage,
      durationMs: Date.now() - startedAt,
      message: String(error?.message || error),
      code: error?.code || null,
      ...extra,
    });
    throw error;
  }
}

function readTabHint() {
  try {
    return JSON.parse(fs.readFileSync(TAB_HINT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeTabHint(targetId, url) {
  try {
    fs.mkdirSync(path.dirname(TAB_HINT_FILE), { recursive: true });
    fs.writeFileSync(TAB_HINT_FILE, JSON.stringify({ targetId, url, ts: new Date().toISOString() }, null, 2));
  } catch {}
}

function clearTabHint() {
  try {
    fs.rmSync(TAB_HINT_FILE, { force: true });
  } catch {}
}

function withSoftTimeout(fn, timeoutMs, onTimeout) {
  const startedAt = Date.now();
  try {
    const result = fn();
    const elapsedMs = Date.now() - startedAt;
    if (timeoutMs && elapsedMs > timeoutMs) {
      onTimeout?.(elapsedMs);
      return { ok: false, timedOut: true, elapsedMs, result };
    }
    return { ok: true, timedOut: false, elapsedMs, result };
  } catch (error) {
    return { ok: false, timedOut: false, elapsedMs: Date.now() - startedAt, error };
  }
}

export function tabs(runner) {
  return runner.oc(['tabs']).tabs || [];
}

function findMatchingHintTab(runner, hint) {
  if (!hint?.targetId && !hint?.url) return null;
  try {
    const allTabs = tabs(runner);
    const hintedUrl = String(hint?.url || '');
    const byId = hint?.targetId ? allTabs.find((entry) => entry?.targetId === hint.targetId) : null;
    if (byId && String(byId.url || '').includes(SONOS_HOST)) return byId;
    if (hintedUrl) {
      const byUrl = allTabs.find((entry) => String(entry?.url || '') === hintedUrl);
      if (byUrl && String(byUrl.url || '').includes(SONOS_HOST)) return byUrl;
    }
    return allTabs.filter((entry) => String(entry?.url || '').includes(SONOS_HOST)).slice(-1)[0] || null;
  } catch {
    return null;
  }
}

export function focus(runner, targetId) {
  runner.oc(['focus', targetId], { parseJson: false });
}

export function close(runner, targetId) {
  runner.oc(['close', targetId], { parseJson: false });
}

export function waitMs(runner, ms) {
  const resident = runner.actBrowser?.({ kind: 'wait', timeMs: Number(ms) || 0 }, { timeoutMs: Math.max(Number(ms) || 0, 1000) + 5000 });
  if (resident) return resident;
  sleepMs(ms);
}

export function waitForLoad(runner, targetId) {
  runner.oc(['wait', '--target-id', targetId, '--load', 'domcontentloaded', '--timeout-ms', '30000'], { parseJson: false });
}

export function navigate(runner, targetId, url) {
  runner.oc(['navigate', url, '--target-id', targetId], { parseJson: false });
}

export function start(runner) {
  runner.oc(['start'], { parseJson: false });
}

function readSonosTabs(runner) {
  return tabs(runner).filter((entry) => String(entry.url || '').includes(SONOS_HOST));
}

export function ensureSonosTab(runner) {
  runner.log({ event: 'ensure-sonos-tab-start', profile: runner.profile, interactionMode: runner.interactionMode() });

  const hint = readTabHint();
  if ((hint?.targetId || hint?.url) && String(hint?.url || '').includes(SONOS_HOST)) {
    const matchedHintTab = findMatchingHintTab(runner, hint);
    if (matchedHintTab?.targetId) {
      runner.log({ event: 'ensure-sonos-tab-hint-found', targetId: matchedHintTab.targetId, url: matchedHintTab.url || hint.url || null, hintedTargetId: hint.targetId || null });
      const hintedTargetId = matchedHintTab.targetId;
      const hintedUrl = String(matchedHintTab.url || hint.url || '');
      writeTabHint(hintedTargetId, hintedUrl);
      if (runner.requiresForeground()) {
        try {
          focus(runner, hintedTargetId);
        } catch (error) {
          runner.log({ event: 'ensure-sonos-tab-hint-focus-failed', targetId: hintedTargetId, message: String(error?.message || error) });
        }
      }
      runEnsureStage(runner, 'post-focus-settle', () => waitMs(runner, 80), {
        targetId: hintedTargetId,
      });
      if (hintedUrl.includes('/search')) {
        runner.rememberTargetUrl?.(hintedTargetId, hintedUrl);
        runner.log({
          event: 'tab-ready-fast-path',
          targetId: hintedTargetId,
          url: hintedUrl,
          foregroundRequired: runner.requiresForeground(),
          interactionMode: runner.interactionMode(),
          profile: runner.profile,
          preservedExistingPage: true,
          skippedLoginRecovery: true,
          source: 'hint',
        });
        return hintedTargetId;
      }
      runner.log({
        event: 'tab-ready-reused-url-only',
        targetId: hintedTargetId,
        url: hintedUrl || null,
        foregroundRequired: runner.requiresForeground(),
        interactionMode: runner.interactionMode(),
        profile: runner.profile,
        preservedExistingPage: true,
        skippedLoadWait: true,
        skippedLoginRecovery: true,
        skippedStateRead: true,
        source: 'hint',
      });
      runner.rememberTargetUrl?.(hintedTargetId, hintedUrl);
      return hintedTargetId;
    }
    runner.log({ event: 'ensure-sonos-tab-hint-stale', targetId: hint?.targetId || null, url: hint?.url || null });
    clearTabHint();
  }

  let allTabs = [];
  if (ENABLE_TABS_BEFORE_START_PROBE) {
    const beforeStartProbe = withSoftTimeout(
      () => runEnsureStage(runner, 'tabs-before-start', () => tabs(runner)),
      TABS_BEFORE_START_SOFT_TIMEOUT_MS,
      (elapsedMs) => runner.log({ event: 'ensure-sonos-tab-tabs-before-start-soft-timeout', elapsedMs, timeoutMs: TABS_BEFORE_START_SOFT_TIMEOUT_MS })
    );

    if (beforeStartProbe.ok && !beforeStartProbe.timedOut) {
      allTabs = beforeStartProbe.result || [];
      runner.log({ event: 'ensure-sonos-tab-skip-start', reason: 'browser-already-responding', tabCount: allTabs.length });
    } else {
      if (beforeStartProbe.error) {
        runner.log({ event: 'ensure-sonos-tab-tabs-before-start-failed', message: String(beforeStartProbe.error?.message || beforeStartProbe.error) });
      }
      if (beforeStartProbe.timedOut) {
        runner.log({ event: 'ensure-sonos-tab-tabs-before-start-skipped', reason: 'soft-timeout', elapsedMs: beforeStartProbe.elapsedMs, timeoutMs: TABS_BEFORE_START_SOFT_TIMEOUT_MS });
      }
    }
  } else {
    runner.log({ event: 'ensure-sonos-tab-tabs-before-start-disabled' });
  }

  if (!allTabs.length) {
    runEnsureStage(runner, 'browser-start', () => start(runner));
    runner.log({ event: 'ensure-sonos-tab-after-start' });
    if (ENABLE_TABS_AFTER_START_PROBE) {
      const afterStartProbe = withSoftTimeout(
        () => runEnsureStage(runner, 'tabs-after-start', () => tabs(runner)),
        TABS_AFTER_START_SOFT_TIMEOUT_MS,
        (elapsedMs) => runner.log({ event: 'ensure-sonos-tab-tabs-after-start-soft-timeout', elapsedMs, timeoutMs: TABS_AFTER_START_SOFT_TIMEOUT_MS })
      );
      if (afterStartProbe.ok && !afterStartProbe.timedOut) {
        allTabs = afterStartProbe.result || [];
      } else {
        if (afterStartProbe.error) {
          runner.log({ event: 'ensure-sonos-tab-tabs-after-start-failed', message: String(afterStartProbe.error?.message || afterStartProbe.error) });
        }
        if (afterStartProbe.timedOut) {
          runner.log({ event: 'ensure-sonos-tab-tabs-after-start-skipped', reason: 'soft-timeout', elapsedMs: afterStartProbe.elapsedMs, timeoutMs: TABS_AFTER_START_SOFT_TIMEOUT_MS });
        }
        allTabs = [];
      }
    } else {
      runner.log({ event: 'ensure-sonos-tab-tabs-after-start-disabled' });
    }
  }

  let sonosTabs = allTabs.filter((entry) => String(entry.url || '').includes(SONOS_HOST));
  if (!sonosTabs.length) sonosTabs = readSonosTabs(runner);
  runner.log({ event: 'ensure-sonos-tab-after-tabs', count: sonosTabs.length, targetIds: sonosTabs.map((entry) => entry?.targetId).filter(Boolean) });

  if (sonosTabs.length > 1) {
    const keepTab = sonosTabs[sonosTabs.length - 1];
    const closeTabs = sonosTabs.slice(0, -1);
    const closedTargetIds = [];

    for (const entry of closeTabs) {
      if (!entry?.targetId) continue;
      runEnsureStage(runner, 'close-extra-sonos-tab', () => close(runner, entry.targetId), {
        targetId: entry.targetId,
        url: entry.url || null,
      });
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

    runEnsureStage(runner, 'tab-hygiene-settle', () => waitMs(runner, 250));
    sonosTabs = runEnsureStage(runner, 'tabs-after-hygiene', () => readSonosTabs(runner));
  }

  let tab = sonosTabs[sonosTabs.length - 1];

  if (!tab) {
    runner.log({ event: 'ensure-sonos-tab-open-search-url', url: SEARCH_URL });
    runEnsureStage(runner, 'open-search-url', () => runner.oc(['open', SEARCH_URL], { parseJson: false }), { url: SEARCH_URL });
    const deadline = Date.now() + 15000;
    let pollIndex = 0;
    while (Date.now() < deadline) {
      pollIndex += 1;
      runEnsureStage(runner, 'poll-open-wait', () => waitMs(runner, 250), { pollIndex });
      sonosTabs = runEnsureStage(runner, 'poll-open-tabs', () => readSonosTabs(runner), { pollIndex });
      tab = sonosTabs[sonosTabs.length - 1];
      runner.log({ event: 'ensure-sonos-tab-poll-open', pollIndex, count: sonosTabs.length, targetIds: sonosTabs.map((entry) => entry?.targetId).filter(Boolean) });
      if (tab?.targetId) break;
    }
  }

  if (!tab?.targetId) {
    clearTabHint();
    throw new SkillError(
      'browser-open',
      'SONOS_WEB_NOT_READY',
      'Unable to find or open the Sonos Web App in the configured OpenClaw browser profile.'
    );
  }

  const tabUrl = String(tab.url || '');
  if (runner.requiresForeground()) {
    runner.log({ event: 'ensure-sonos-tab-before-focus', targetId: tab.targetId, url: tabUrl || null });
    runEnsureStage(runner, 'focus-existing-sonos-tab', () => focus(runner, tab.targetId), {
      targetId: tab.targetId,
      url: tabUrl || null,
    });
    runner.log({ event: 'ensure-sonos-tab-after-focus', targetId: tab.targetId });
  } else {
    runner.log({
      event: 'ensure-sonos-tab-skip-focus',
      targetId: tab.targetId,
      url: tabUrl || null,
      interactionMode: runner.interactionMode(),
    });
  }

  runEnsureStage(runner, 'post-focus-settle', () => waitMs(runner, 80), {
    targetId: tab.targetId,
  });

  if (tabUrl.includes('/search')) {
    writeTabHint(tab.targetId, tabUrl);
    runner.rememberTargetUrl?.(tab.targetId, tabUrl);
    runner.log({
      event: 'tab-ready-fast-path',
      targetId: tab.targetId,
      url: tabUrl,
      foregroundRequired: runner.requiresForeground(),
      interactionMode: runner.interactionMode(),
      profile: runner.profile,
      preservedExistingPage: true,
      skippedLoginRecovery: true,
    });
    return tab.targetId;
  }

  writeTabHint(tab.targetId, tabUrl);
  runner.rememberTargetUrl?.(tab.targetId, tabUrl);
  runner.log({
    event: 'tab-ready-reused-url-only',
    targetId: tab.targetId,
    url: tabUrl || null,
    foregroundRequired: runner.requiresForeground(),
    interactionMode: runner.interactionMode(),
    profile: runner.profile,
    preservedExistingPage: true,
    skippedLoadWait: true,
    skippedLoginRecovery: true,
    skippedStateRead: true,
  });
  return tab.targetId;

}
