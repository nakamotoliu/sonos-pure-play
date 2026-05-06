#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PurePlayBrowserRunner } from './browser-runner.mjs';
import { SEARCH_URL } from './selectors.mjs';
import { analyzeIntent } from './intent.mjs';
import { buildQueryPlan } from './query-planner.mjs';
import { extractUsablePageBlocks } from './browser-surface-tools.mjs';
import { openPlaybackActionMenu, choosePlaybackAction } from './browser-action-tools.mjs';
import { SkillError } from './normalize.mjs';
import { clickCandidateAndReadDetail, waitForPlaybackSurfaceReady } from './run-live-once.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(SCRIPT_DIR, '..');
const ARTIFACT_DIR = path.join(SKILL_DIR, 'logs', 'live-page-tests.local');

function usage() {
  console.log([
    'Usage:',
    '  node skills/sonos-pure-play/scripts/test-live-page-flow.mjs <request> [--room <room>] [--execute-playback]',
    '',
    'What this tests on the REAL Sonos Web page:',
    '  1. profile/login/search page readiness',
    '  2. query is really written and retained in the search input',
    '  3. real results are visible, not search history',
    '  4. real candidates can be extracted/ranked',
    '  5. the chosen real candidate can be opened into a detail surface',
    '  6. the real 更多选项 playback menu exposes 替换队列/立即播放',
    '',
    'Safe by default: it opens the menu but does NOT click playback actions.',
    'Use --execute-playback only when you intentionally want to mutate the real queue.',
  ].join('\n'));
}

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function parseArgs(argv) {
  const positional = [];
  let room = null;
  let executePlayback = false;
  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || '').trim();
    if (!value) continue;
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--execute-playback') {
      executePlayback = true;
      continue;
    }
    if (value === '--room') {
      room = String(argv[i + 1] || '').trim() || null;
      i += 1;
      continue;
    }
    if (value.startsWith('--room=')) {
      room = value.slice('--room='.length).trim() || null;
      continue;
    }
    positional.push(value);
  }
  return { request: positional.join(' ').trim(), room, executePlayback };
}

function assertTrue(condition, code, message, data = {}) {
  if (!condition) throw new SkillError('live-page-test', code, message, data);
}

function latestCandidate(surface) {
  const candidates = Array.isArray(surface?.usableBlocks?.candidates) ? surface.usableBlocks.candidates : [];
  return candidates.find((item) => item.recommended) || candidates[0] || null;
}

function writeArtifact(payload) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-live-page-flow.json`;
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.request) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const startedAt = new Date().toISOString();
  const runner = new PurePlayBrowserRunner({
    profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless',
    logger: (event) => emit({ phase: 'runner', ...event }),
  });

  const intent = analyzeIntent({ request: args.request, requestedMode: 'play' });
  const plan = buildQueryPlan({ request: intent.mediaRequest });
  const query = plan.queries?.[0] || intent.mediaRequest || args.request;
  const checks = [];

  const recordCheck = (name, ok, data = {}) => {
    const entry = { name, ok: Boolean(ok), ...data };
    checks.push(entry);
    emit({ phase: 'live-page-test', event: 'check', ...entry });
  };

  let artifactPath = null;
  try {
    emit({
      phase: 'live-page-test',
      event: 'start',
      request: args.request,
      room: args.room,
      query,
      executePlayback: args.executePlayback,
      searchUrl: SEARCH_URL,
    });

    const targetId = runner.ensureSonosTab();
    recordCheck('real-sonos-tab-ready', true, { targetId });

    const login = runner.assertLoggedIn(targetId);
    recordCheck('real-login-preflight', Boolean(login?.ok), { state: login?.state ? {
      url: login.state.url,
      title: login.state.title,
      loginBlocked: login.state.loginBlocked,
      challengeRequired: login.state.challengeRequired,
    } : null });

    const nav = runner.navigateVerified(targetId, SEARCH_URL, { settleMs: 400 }).actionResult;
    recordCheck('real-search-page-navigate', Boolean(nav), { targetId });

    const gate = runner.ensureQueryGateVerified(targetId, query, {
      pageReloads: 1,
      inputAttempts: 1,
      settleMs: 500,
    }).actionResult;
    const gateState = gate?.attempt?.gate || gate?.gate || null;
    recordCheck('real-query-gate', Boolean(gate?.ok), {
      query,
      searchPageReady: gateState?.searchPageReady ?? null,
      queryApplied: gateState?.queryApplied ?? null,
      pageKind: gateState?.pageKind ?? null,
      searchValue: gateState?.searchValue ?? null,
      historyVisible: gateState?.historyVisible ?? null,
      resultsFreshForExpectedQuery: gateState?.resultsFreshForExpectedQuery ?? null,
    });
    assertTrue(gate?.ok, 'LIVE_QUERY_GATE_FAILED', 'Real Sonos page did not accept and retain the search query.', { gate });

    const fullState = runner.checkSearchQueryApplied(targetId, query, { mode: 'full' });
    const searchState = fullState?.state || fullState || {};
    recordCheck('real-search-results-visible', Boolean(
      searchState?.searchPageReady &&
      searchState?.queryApplied &&
      searchState?.resultsPresent &&
      searchState?.resultsFreshForExpectedQuery &&
      !searchState?.historyVisible
    ), {
      pageKind: searchState?.pageKind,
      resultsPresent: searchState?.resultsPresent,
      historyVisible: searchState?.historyVisible,
      resultsFreshForExpectedQuery: searchState?.resultsFreshForExpectedQuery,
      serviceLabels: searchState?.serviceLabels,
      typeLabelCounts: searchState?.typeLabelCounts,
      playableButtonCount: searchState?.playableButtonCount,
    });
    assertTrue(searchState?.resultsPresent && searchState?.resultsFreshForExpectedQuery, 'LIVE_RESULTS_NOT_READY', 'Real Sonos page did not expose fresh search results.', { fullState });

    const surface = extractUsablePageBlocks(runner, targetId, {
      originalIntent: plan.originalIntent,
      query,
      requestKind: plan.requestKind,
      strategy: plan.strategy,
      allowedTypes: plan.allowedTypes,
    });
    const candidates = Array.isArray(surface?.usableBlocks?.candidates) ? surface.usableBlocks.candidates : [];
    const chosen = latestCandidate(surface);
    recordCheck('real-candidates-extracted', candidates.length > 0 && Boolean(chosen), {
      candidateCount: candidates.length,
      chosen: chosen ? {
        title: chosen.title,
        type: chosen.type,
        playLabel: chosen.playLabel,
        finalScore: chosen.finalScore,
        recommended: chosen.recommended,
        recommendedReason: chosen.recommendedReason,
      } : null,
      summary: surface?.usableBlocks?.selectionSummary || null,
    });
    assertTrue(chosen?.playLabel || chosen?.title, 'LIVE_NO_CANDIDATE', 'Real Sonos page did not yield a clickable candidate.', { candidates: candidates.slice(0, 10) });

    const clicked = clickCandidateAndReadDetail(runner, targetId, chosen, { timeoutMs: 10000, intervalMs: 180 });
    recordCheck('real-candidate-click-opens-detail', Boolean(clicked?.ok && clicked?.state?.url && clicked.state.url !== SEARCH_URL), {
      clicked: clicked?.clicked || null,
      url: clicked?.state?.url || null,
      layers: clicked?.state?.layers ? Object.keys(clicked.state.layers) : [],
    });
    assertTrue(clicked?.ok, 'LIVE_CANDIDATE_CLICK_FAILED', 'Could not click the real Sonos candidate.', { clicked, chosen });

    const detail = waitForPlaybackSurfaceReady(runner, targetId, { timeoutMs: 10000, intervalMs: 180 });
    recordCheck('real-detail-surface-ready', Boolean(detail?.ok), {
      url: detail?.url,
      headings: detail?.headings,
      buttons: (detail?.buttons || []).slice(0, 12),
      bodyPreview: detail?.bodyPreview,
    });
    assertTrue(detail?.ok, 'LIVE_DETAIL_NOT_READY', 'Real candidate did not open a playable detail surface.', { detail, chosen });

    const menu = openPlaybackActionMenu(runner, targetId, { preferredLabels: ['替换队列', '立即播放'], waitMs: 300 });
    recordCheck('real-playback-menu-visible', Boolean(menu?.ok), {
      detailHeading: menu?.detailHeading,
      availableActions: menu?.availableActions,
      clickedMoreOptions: menu?.clickedMoreOptions,
      menuAlreadyOpen: menu?.menuAlreadyOpen,
    });
    assertTrue(menu?.ok, 'LIVE_PLAYBACK_MENU_NOT_VISIBLE', 'Real detail page did not expose expected playback menu actions.', { menu, chosen });

    let playbackAction = null;
    if (args.executePlayback) {
      playbackAction = choosePlaybackAction(runner, targetId, ['替换队列', '立即播放'], { waitMs: 300 });
      recordCheck('real-playback-action-clicked', Boolean(playbackAction?.ok), {
        actualLabel: playbackAction?.actualLabel,
        normalizedAction: playbackAction?.normalizedAction,
        postClickVisibleMenuItems: playbackAction?.postClickVisibleMenuItems,
      });
    } else {
      recordCheck('real-playback-action-skipped-safe-default', true, { reason: 'pass --execute-playback to mutate queue' });
    }

    const report = {
      ok: true,
      phase: 'live-page-test',
      startedAt,
      endedAt: new Date().toISOString(),
      request: args.request,
      room: args.room,
      query,
      executePlayback: args.executePlayback,
      targetId,
      checks,
      chosen: chosen ? {
        title: chosen.title,
        type: chosen.type,
        playLabel: chosen.playLabel,
        finalScore: chosen.finalScore,
        recommended: chosen.recommended,
        recommendedReason: chosen.recommendedReason,
      } : null,
      menu: menu ? {
        detailHeading: menu.detailHeading,
        availableActions: menu.availableActions,
      } : null,
      playbackAction,
    };
    artifactPath = writeArtifact(report);
    console.log(JSON.stringify({ ...report, artifactPath }, null, 2));
    runner.closeResident();
  } catch (error) {
    const report = {
      ok: false,
      phase: 'live-page-test',
      startedAt,
      endedAt: new Date().toISOString(),
      request: args.request,
      room: args.room,
      query,
      executePlayback: args.executePlayback,
      code: error?.code || null,
      message: String(error?.message || error),
      data: error?.data || null,
      checks,
    };
    artifactPath = writeArtifact(report);
    console.log(JSON.stringify({ ...report, artifactPath }, null, 2));
    runner.closeResident();
    process.exit(1);
  }
}

main();
