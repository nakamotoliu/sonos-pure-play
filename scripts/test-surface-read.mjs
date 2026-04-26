#!/usr/bin/env node
import { PurePlayBrowserRunner } from './browser-runner.mjs';
import { SEARCH_URL } from './selectors.mjs';
import { analyzeIntent } from './intent.mjs';
import { buildQueryPlan } from './query-planner.mjs';
import { extractUsablePageBlocks } from './browser-surface-tools.mjs';

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

const request = process.argv.slice(2).join(' ').trim();
if (!request) {
  console.error('Usage: node skills/sonos-pure-play/scripts/test-surface-read.mjs <request>');
  process.exit(2);
}

const runner = new PurePlayBrowserRunner({
  profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless',
  logger: (event) => emit({ phase: 'runner', ...event }),
});

try {
  const intent = analyzeIntent({ request, requestedMode: 'play' });
  const plan = buildQueryPlan({ request: intent.mediaRequest });
  const query = plan.queries?.[0] || intent.mediaRequest || request;

  emit({
    phase: 'surface-read-test',
    event: 'start',
    request,
    query,
    strategy: plan.strategy,
    requestKind: plan.requestKind,
    allowedTypes: plan.allowedTypes,
    searchUrl: SEARCH_URL,
  });

  const targetId = runner.ensureSonosTab();
  emit({ phase: 'surface-read-test', event: 'tab-ready', targetId });

  const resetNav = runner.navigateVerified(targetId, SEARCH_URL, { settleMs: 400 }).actionResult;
  emit({ phase: 'surface-read-test', event: 'reset-to-search-page', targetId, resetNav });

  const before = runner.checkSearchQueryApplied(targetId, query, { mode: 'full' });
  emit({ phase: 'surface-read-test', event: 'before-gate', request, query, state: before });

  let gate = null;
  let gateError = null;
  try {
    gate = runner.ensureQueryGateVerified(targetId, query, {
      pageReloads: 1,
      inputAttempts: 1,
      settleMs: 500,
    }).actionResult;
    emit({ phase: 'surface-read-test', event: 'after-gate', request, query, gate });
  } catch (error) {
    gateError = {
      code: error?.code || null,
      message: String(error?.message || error),
      data: error?.data || null,
    };
    emit({ phase: 'surface-read-test', event: 'gate-blocked', request, query, gateError });
  }

  const after = runner.checkSearchQueryApplied(targetId, query, { mode: 'full' });
  emit({ phase: 'surface-read-test', event: 'after-full-state', request, query, state: after });

  const surface = extractUsablePageBlocks(runner, targetId, {
    originalIntent: plan.originalIntent,
    query,
    requestKind: plan.requestKind,
    strategy: plan.strategy,
    allowedTypes: plan.allowedTypes,
  });

  const summary = surface?.usableBlocks?.selectionSummary || null;
  const candidates = Array.isArray(surface?.usableBlocks?.candidates) ? surface.usableBlocks.candidates : [];
  emit({
    phase: 'surface-read-test',
    event: 'surface-read',
    request,
    query,
    summary,
    candidates: candidates.slice(0, 10),
    serviceTabs: (surface?.usableBlocks?.serviceTabs || []).slice(0, 10),
    inputs: (surface?.usableBlocks?.inputs || []).slice(0, 5),
    rows: (surface?.usableBlocks?.rows || []).slice(0, 10),
  });

  console.log(JSON.stringify({
    ok: true,
    phase: 'surface-read-test',
    request,
    query,
    report: {
      before,
      gate,
      gateError,
      after,
      summary,
      candidates,
    },
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    phase: 'surface-read-test',
    request,
    code: error?.code || null,
    message: error?.message || String(error),
    data: error?.data || null,
  }));
  process.exit(1);
}
