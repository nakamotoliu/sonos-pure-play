#!/usr/bin/env node
import { PurePlayBrowserRunner } from './browser-runner.mjs';
import { SEARCH_URL } from './selectors.mjs';

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

const [query] = process.argv.slice(2).map((v) => String(v || '').trim()).filter(Boolean);
if (!query) {
  console.error('Usage: node skills/sonos-pure-play/scripts/test-query-gate.mjs <query>');
  process.exit(2);
}

const runner = new PurePlayBrowserRunner({
  profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless',
  logger: (event) => emit({ phase: 'runner', ...event }),
});

try {
  emit({ phase: 'query-gate-test', event: 'start', query, searchUrl: SEARCH_URL });

  const targetId = runner.ensureSonosTab();
  emit({ phase: 'query-gate-test', event: 'tab-ready', targetId });

  const resetNav = runner.navigateVerified(targetId, SEARCH_URL, { settleMs: 400 }).actionResult;
  emit({ phase: 'query-gate-test', event: 'reset-to-search-page', targetId, resetNav });

  const before = runner.checkSearchQueryApplied(targetId, query, { mode: 'full' });
  emit({ phase: 'query-gate-test', event: 'before-gate', query, state: before });

  const gate = runner.ensureQueryGateVerified(targetId, query, {
    pageReloads: 1,
    inputAttempts: 1,
    settleMs: 500,
  }).actionResult;
  emit({ phase: 'query-gate-test', event: 'after-gate', query, gate });

  const after = runner.checkSearchQueryApplied(targetId, query, { mode: 'full' });
  emit({ phase: 'query-gate-test', event: 'after-full-state', query, state: after });

  console.log(JSON.stringify({
    ok: true,
    phase: 'query-gate-test',
    query,
    report: {
      before,
      gate,
      after,
    },
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    phase: 'query-gate-test',
    query,
    code: error?.code || null,
    message: error?.message || String(error),
    data: error?.data || null,
  }));
  process.exit(1);
}
