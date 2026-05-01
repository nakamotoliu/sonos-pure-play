#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PurePlayBrowserRunner } from './browser-runner.mjs';
import {
  resolveRoom,
  getStatus,
  getQueueJson,
  getGroupStatus,
  ensureSoloRoom,
  applyControlSteps,
} from './cli-control.mjs';
import { analyzeIntent } from './intent.mjs';
import { buildQueryPlan } from './query-planner.mjs';
import { extractUsablePageBlocks, buildSelectionDecisionReport } from './browser-surface-tools.mjs';
import { verifyMediaPlayback, MAX_PLAYBACK_ATTEMPTS } from './verify.mjs';
import { SkillError } from './normalize.mjs';
import { ACTION_PRIORITY, DEFAULT_ACTION } from './selectors.mjs';
import { notifyFailureArtifact, notifySuccessArtifact, saveSuccessScreenshot } from './failure-notify.mjs';
import {
  buildCandidateAttemptPool,
  DEFAULT_MAX_CANDIDATES_PER_QUERY,
  shouldRetryWithNextCandidate,
  shouldRetryWithNextQuery,
} from './run-live-retry.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_RECORD_PATH = path.join(SCRIPT_DIR, '..', 'logs', 'run-records.local.jsonl');
const MAX_QUERY_ATTEMPTS = Number(process.env.SONOS_MAX_QUERY_ATTEMPTS || 2);
const NAVIGATE_SETTLE_MS = Number(process.env.SONOS_NAVIGATE_SETTLE_MS || 400);
const QUERY_GATE_SETTLE_MS = Number(process.env.SONOS_QUERY_GATE_SETTLE_MS || 500);
const QUERY_GATE_RETRY_SETTLE_MS = Number(process.env.SONOS_QUERY_GATE_RETRY_SETTLE_MS || 350);
const CANDIDATE_CLICK_POST_LOAD_WAIT_MS = Number(process.env.SONOS_CANDIDATE_CLICK_POST_LOAD_WAIT_MS || 250);
const PLAYBACK_ACTION_WAIT_MS = Number(process.env.SONOS_PLAYBACK_ACTION_WAIT_MS || 200);

function ensureFreshSearchResults(runner, targetId, query, { settleMs = QUERY_GATE_SETTLE_MS, recoverySettleMs = NAVIGATE_SETTLE_MS } = {}) {
  const first = runner.ensureQueryGateVerified(targetId, query, { pageReloads: 0, inputAttempts: 1, settleMs }).actionResult;
  const firstState = first?.attempt?.gate?.state || first?.attempt?.gate || {};
  const firstFresh = Boolean(firstState?.onSearchPage && firstState?.searchPageReady && firstState?.resultsFreshForExpectedQuery);
  if (firstFresh) return { queryGate: first, recovered: false };

  emit({
    phase: 'query-gate-recover-search-page',
    query,
    reason: firstState?.pageKind || 'not-fresh',
    onSearchPage: Boolean(firstState?.onSearchPage),
    searchPageReady: Boolean(firstState?.searchPageReady),
    resultsFreshForExpectedQuery: Boolean(firstState?.resultsFreshForExpectedQuery),
  });
  runner.recoverSearchPageVerified(targetId, query, { settleMs: recoverySettleMs });
  const second = runner.ensureQueryGateVerified(targetId, query, { pageReloads: 0, inputAttempts: 1, settleMs }).actionResult;
  return { queryGate: second, recovered: true };
}

function appendRunRecord(entry) {
  fs.mkdirSync(path.dirname(RUN_RECORD_PATH), { recursive: true });
  fs.appendFileSync(RUN_RECORD_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function extractEvidence(error) {
  return error?.data?.evidence || null;
}

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function fail(phase, error, extra = {}) {
  const evidence = extractEvidence(error);
  const payload = {
    ok: false,
    phase,
    code: error?.code || null,
    message: error?.message || String(error),
    data: error?.data || null,
    ...extra,
  };
  appendRunRecord({
    kind: 'run-failed',
    phase,
    code: payload.code,
    message: payload.message,
    evidence,
    extra,
  });
  if (evidence?.artifactPath || evidence?.screenshotPath) {
    try {
      const notifyResult = notifyFailureArtifact({
        capturedAt: new Date().toISOString(),
        step: error?.data?.step || null,
        room: extra?.room || null,
        request: extra?.request || null,
        query: extra?.query || null,
        targetId: error?.data?.targetId || null,
        artifactPath: evidence?.artifactPath || null,
        screenshotPath: evidence?.screenshotPath || null,
        error,
      });
      appendRunRecord({ kind: 'failure-notified', notifyResult, artifactPath: evidence?.artifactPath || null });
    } catch (notifyError) {
      appendRunRecord({
        kind: 'failure-notify-failed',
        message: String(notifyError?.message || notifyError),
        artifactPath: evidence?.artifactPath || null,
      });
    }
  }
  console.log(JSON.stringify(payload));
  process.exit(1);
}

function buildSelectionFromChosen(surface, chosen) {
  const candidates = surface?.usableBlocks?.candidates || [];
  const recommended = candidates.filter((c) => c.recommended);
  const topRecommended = surface?.usableBlocks?.selectionSummary?.topRecommended || null;
  const decisionReason = chosen
    ? (chosen.recommendedReason || (recommended.length ? 'recommended-by-ranker' : 'top-score'))
    : 'no-candidate';
  return {
    chosen,
    topRecommended,
    decisionReason,
    report: buildSelectionDecisionReport({
      usableBlocks: surface?.usableBlocks || {},
      chosenTitle: chosen?.title || '',
      chosenType: chosen?.type || '',
      decisionReason,
    }),
  };
}

function chooseCandidate(surface) {
  const attemptPool = buildCandidateAttemptPool(surface, { maxCandidates: DEFAULT_MAX_CANDIDATES_PER_QUERY });
  const chosen = attemptPool[0] || null;
  return {
    ...buildSelectionFromChosen(surface, chosen),
    attemptPool,
  };
}

function clickCandidateAndReadDetail(runner, targetId, chosen, { timeoutMs = 9000, intervalMs = 180 } = {}) {
  const playLabel = chosen?.playLabel || '';
  if (!playLabel) throw new Error('chosen candidate has no playLabel');
  const result = runner.evaluate(
    targetId,
    `async () => {
      const wantedLabel = ${JSON.stringify(playLabel)};
      const timeoutMs = ${Number(timeoutMs)};
      const intervalMs = ${Number(intervalMs)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute?.('aria-label') || el?.textContent || '');
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const buttons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
      const target = buttons.find((el) => textOf(el) === wantedLabel) || null;
      if (!target) {
        return {
          ok: false,
          reason: 'button-not-found',
          clicked: null,
          visibleButtons: buttons.map((el) => textOf(el)).filter(Boolean).slice(0, 40),
        };
      }
      target.click();
      const startedAt = Date.now();
      let state = null;
      while (Date.now() - startedAt <= timeoutMs) {
        const main = document.querySelector('main') || document.body;
        const text = normalize(main?.innerText || document.body?.innerText || '');
        const detail = [...document.querySelectorAll('main h1, main h2, main [role="heading"], main button')]
          .filter(visible)
          .map((el) => textOf(el))
          .filter(Boolean);
        const hasDetail = detail.some((label) => label === '更多选项' || label.startsWith('随机播放'));
        state = {
          url: location.href,
          title: document.title || '',
          appError: /Application error|应用错误/.test(text),
          bootstrapBlank: !text,
          loginBlocked: /登录|Sign in|Log in/.test(text),
          challengeRequired: /captcha|challenge|验证/.test(text),
          layers: {
            detail: hasDetail || location.href.includes('/browse/services/') ? detail.slice(0, 120) : [],
            search: text ? [text.slice(0, 1200)] : [],
          },
        };
        if (state.appError || state.loginBlocked || state.challengeRequired) break;
        if (state.layers.detail.length > 0) break;
        await sleep(intervalMs);
      }
      return {
        ok: true,
        clicked: wantedLabel,
        state,
        elapsedMs: Date.now() - startedAt,
      };
    }`
  );
  const clicked = result?.result || result;
  if (!clicked?.ok) throw new Error(`candidate click failed: ${playLabel}`);
  return clicked;
}

function waitForPlaybackSurfaceReady(runner, targetId, { timeoutMs = 10000, intervalMs = 180 } = {}) {
  const result = runner.evaluate(
    targetId,
    `async () => {
      const timeoutMs = ${Number(timeoutMs)};
      const intervalMs = ${Number(intervalMs)};
      const unavailablePatterns = [/应版权方要求暂不能播放/, /版权方要求暂不能播放/, /暂不能播放/, /无法播放/, /unavailable/i, /not available/i, /copyright/i];
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute?.('aria-label') || el?.textContent || '');
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const startedAt = Date.now();
      let state = null;
      while (Date.now() - startedAt <= timeoutMs) {
        const main = document.querySelector('main') || document.body;
        const buttons = [...document.querySelectorAll('main button, main [role="button"], main [role="menuitem"]')]
          .filter(visible)
          .map((el) => textOf(el))
          .filter(Boolean);
        const headings = [...document.querySelectorAll('main h1, main h2, main [role="heading"]')]
          .filter(visible)
          .map((el) => textOf(el))
          .filter(Boolean);
        const text = normalize(main?.innerText || document.body?.innerText || '');
        const copyrightBlocked = unavailablePatterns.some((pattern) => pattern.test(text));
        state = {
          ok: buttons.includes('更多选项') || buttons.some((label) => /^随机播放/.test(label)),
          copyrightBlocked,
          url: location.href,
          headings: headings.slice(0, 12),
          buttons: buttons.slice(0, 60),
          bodyPreview: text.slice(0, 240),
        };
        if (state.ok || state.copyrightBlocked) break;
        await sleep(intervalMs);
      }
      return state;
    }`
  );
  return result?.result || result || { ok: false };
}

function captureSuccessScreenshot(runner, targetId) {
  try {
    const screenshot = runner.screenshotRoot(targetId);
    const mediaPath = screenshot?.mediaPath || null;
    if (!mediaPath || !fs.existsSync(mediaPath)) return null;
    return {
      raw: screenshot,
      savedPath: saveSuccessScreenshot({ sourcePath: mediaPath, step: 'run-succeeded' }),
    };
  } catch {
    return null;
  }
}

const [roomInput, ...requestParts] = process.argv.slice(2);
const request = requestParts.join(' ').trim();
if (!roomInput || !request) {
  console.error('Usage: node skills/sonos-pure-play/scripts/run-live-once.mjs <room> <request>');
  process.exit(2);
}

const logger = (event) => {
  emit({ phase: 'runner', ...event });
  if (['step-start', 'step-ok', 'step-failed', 'failure-evidence-captured', 'browser-command-failed'].includes(event?.event)) {
    appendRunRecord({ kind: 'runner-event', ...event });
  }
};
const runner = new PurePlayBrowserRunner({ logger, profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw-headless' });

let finalizedBySignal = false;
function closeRunnerForExit(kind) {
  try {
    const closeResidentResult = runner.closeResident?.() || null;
    appendRunRecord({ kind, closeResidentResult });
    return closeResidentResult;
  } catch (error) {
    appendRunRecord({ kind: `${kind}-failed`, message: String(error?.message || error) });
    return null;
  }
}

function recordSignalFailure(signal) {
  if (finalizedBySignal) return;
  finalizedBySignal = true;
  const step = runner.currentStep || 'process-signal';
  let evidence = null;
  try {
    evidence = runner.captureFailureEvidence(step, {
      targetId: runner.currentTargetId || null,
      error: new Error(`run-live-once interrupted by ${signal}`),
      context: {
        ...(runner.currentStepContext || {}),
        signal,
      },
    });
  } catch (error) {
    evidence = {
      ok: false,
      message: String(error?.message || error),
    };
  }
  const closeResidentResult = closeRunnerForExit('browser-runner-closed-after-signal');
  appendRunRecord({
    kind: 'run-signaled',
    signal,
    step,
    targetId: runner.currentTargetId || null,
    context: runner.currentStepContext || null,
    evidence,
    closeResidentResult,
  });
}

process.on('SIGTERM', () => {
  recordSignalFailure('SIGTERM');
  process.exit(143);
});

process.on('SIGINT', () => {
  recordSignalFailure('SIGINT');
  process.exit(130);
});

try {
  appendRunRecord({ kind: 'run-start', roomInput, request, maxPlaybackAttempts: MAX_PLAYBACK_ATTEMPTS });
  emit({ phase: 'start', roomInput, request });

  const room = resolveRoom(roomInput);
  emit({ phase: 'resolve-room', room });

  const intent = analyzeIntent({ request, requestedMode: DEFAULT_ACTION });
  emit({ phase: 'intent', intent });

  const plan = buildQueryPlan({ request: intent.mediaRequest });
  emit({ phase: 'query-plan', plan: { intent: plan.intent, queries: plan.queries, strategy: plan.strategy, requestKind: plan.requestKind } });

  const groupBefore = getGroupStatus();
  const solo = ensureSoloRoom(room, groupBefore);
  emit({ phase: 'group-normalize', changed: solo.changed });

  if (intent.controlSteps?.length) {
    const controlResults = applyControlSteps(room, intent.controlSteps);
    emit({ phase: 'control-steps', controlResults });
  }

  const preStatus = getStatus(room);
  const preQueueJson = getQueueJson(room, 20);
  emit({ phase: 'preflight', preStatus, preQueueCount: preQueueJson?.items?.length || 0 });

  const targetId = runner.runStep('ensure-sonos-tab', {
    action: () => runner.ensureSonosTab(),
    verify: (result) => ({ ok: Boolean(result), targetId: result }),
  }).actionResult;
  emit({ phase: 'browser', event: 'tab-ready', targetId });

  const loginPreflight = runner.runStep('sonos-login-preflight', {
    targetId,
    action: () => runner.assertLoggedIn(targetId),
    verify: (result) => ({ ok: Boolean(result?.ok), result }),
  }).actionResult;
  emit({ phase: 'browser', event: 'login-preflight-ok', targetId, state: loginPreflight?.state || null });

  const roomSync = runner.runStep('room-sync-read-before', {
    targetId,
    context: { room },
    action: () => runner.readRoomSyncState(targetId, room),
    verify: (result) => {
      if (result?.code === 'SONOS_WEB_PROFILE_LOGGED_OUT' || result?.code === 'LOGIN_CHALLENGE_REQUIRED' || result?.loginBlocked || result?.challengeRequired) {
        throw new SkillError(
          'preflight',
          result?.code || 'SONOS_WEB_PROFILE_LOGGED_OUT',
          result?.code === 'LOGIN_CHALLENGE_REQUIRED'
            ? 'Sonos Web requires additional verification before playback can continue.'
            : 'Sonos Web is logged out in the selected browser profile. Restore login for this profile before running playback.',
          { profile: runner.profile, url: result?.url || null, result }
        );
      }
      return {
        ok: Boolean(result?.ok === false ? false : true),
        result,
        warning: result?.roomVisible || result?.roomCardFound ? null : 'room-not-visible-on-current-page',
      };
    },
  }).actionResult;
  emit({ phase: 'room-sync-before', roomSync });
  let roomSyncAfter = roomSync;
  if (!roomSync?.activeRoomConfirmed) {
    const activate = runner.runStep('room-sync-activate', {
      targetId,
      context: { room },
      action: () => runner.clickRoomActivate(targetId, room),
      verify: (result) => ({ ok: Boolean(result?.ok), result }),
    }).actionResult;
    emit({ phase: 'room-sync-click', activate });
    runner.waitMs(200);
    roomSyncAfter = runner.runStep('room-sync-read-after', {
      targetId,
      context: { room },
      action: () => runner.readRoomSyncState(targetId, room),
      verify: (result) => ({ ok: Boolean(result?.activeRoomConfirmed || result?.roomCardFound), result }),
    }).actionResult;
  } else {
    emit({ phase: 'room-sync-after-skipped', reason: 'already-active', room });
  }
  emit({ phase: 'room-sync-after', roomSyncAfter });

  let finalResult = null;
  let lastError = null;

  for (const query of plan.queries.slice(0, MAX_QUERY_ATTEMPTS)) {
    emit({ phase: 'query-attempt', query });

    try {
      runner.recoverSearchPageVerified(targetId, query, { settleMs: NAVIGATE_SETTLE_MS });
      const { queryGate, recovered } = ensureFreshSearchResults(runner, targetId, query, { settleMs: QUERY_GATE_SETTLE_MS });
      emit({ phase: 'query-gate', query, queryGate, recovered });
      const gateState = queryGate?.attempt?.gate?.state || queryGate?.attempt?.gate || {};
      const readyForCandidateExtraction = Boolean(gateState?.onSearchPage && gateState?.searchPageReady && gateState?.resultsFreshForExpectedQuery);
      if (!readyForCandidateExtraction) {
        throw new Error(`Search results not fresh for query: ${query}`);
      }

      const surface = runner.runStep('surface-read', {
        targetId,
        context: { query, requestKind: plan.requestKind, strategy: plan.strategy },
        action: () => extractUsablePageBlocks(runner, targetId, {
          originalIntent: plan.originalIntent,
          query,
          requestKind: plan.requestKind,
          strategy: plan.strategy,
          allowedTypes: plan.allowedTypes,
        }),
        verify: (result) => ({ ok: Array.isArray(result?.usableBlocks?.candidates), resultSummary: result?.usableBlocks?.selectionSummary || null }),
      }).actionResult;
      emit({ phase: 'surface', query, summary: surface?.usableBlocks?.selectionSummary || null, candidates: (surface?.usableBlocks?.candidates || []).slice(0, 5) });

      const selection = chooseCandidate(surface);
      emit({ phase: 'selection', query, selection });
      if (!selection.chosen) {
        lastError = new Error(`No candidate for query: ${query}`);
        continue;
      }

      const actionNames = ACTION_PRIORITY[intent.actionPreference || DEFAULT_ACTION] || ACTION_PRIORITY[DEFAULT_ACTION];

      for (const chosenCandidate of selection.attemptPool) {
        const candidateSelection = buildSelectionFromChosen(surface, chosenCandidate);
        emit({ phase: 'candidate-attempt', query, chosenCandidate, decisionReason: candidateSelection.decisionReason });

        try {
          runner.runStep('candidate-click', {
            targetId,
            context: { query, title: chosenCandidate?.title || null, playLabel: chosenCandidate?.playLabel || null },
            action: () => {
              const clicked = clickCandidateAndReadDetail(runner, targetId, chosenCandidate, {
                timeoutMs: Math.max(CANDIDATE_CLICK_POST_LOAD_WAIT_MS, 9000),
              });
              return {
                clicked,
                state: clicked.state,
              };
            },
            verify: (result) => ({
              ok: Boolean(
                result?.clicked?.ok && (
                  (result?.state?.layers?.detail || []).length > 0 ||
                  String(result?.state?.url || '').includes('/browse/services/') ||
                  String(result?.state?.url || '').includes('/search')
                )
              ),
              result,
            }),
          });

          const playbackSurfaceReady = runner.runStep('playback-surface-ready', {
            targetId,
            context: { query, title: chosenCandidate?.title || null },
            action: () => waitForPlaybackSurfaceReady(runner, targetId),
            verify: (result) => {
              if (result?.copyrightBlocked) {
                throw new SkillError(
                  'browser-action',
                  'PLAYBACK_SURFACE_COPYRIGHT_BLOCKED',
                  'The selected Sonos detail page contains copyright/unavailable markers before playback.',
                  { targetId, query, chosenCandidate, result, retryable: true, retryReason: 'copyright-unavailable-surface' }
                );
              }
              return { ok: Boolean(result?.ok), result };
            },
          }).actionResult;
          emit({ phase: 'playback-surface-ready', query, playbackSurfaceReady, chosenCandidate });

          const playbackAction = runner.choosePlaybackActionVerified(targetId, actionNames, { waitMs: PLAYBACK_ACTION_WAIT_MS }).actionResult;
          emit({ phase: 'playback-action', query, playbackAction, chosenCandidate });

          const afterStatus = getStatus(room);
          const afterQueueJson = getQueueJson(room, 20);
          const verified = verifyMediaPlayback({
            room,
            actionName: playbackAction.actualLabel,
            postStatus: preStatus,
            followupStatus: afterStatus,
            followupQueueJson: afterQueueJson,
            retryPlay: () => applyControlSteps(room, [{ kind: 'play' }]),
            retrySnapshot: () => ({ status: getStatus(room), queueJson: getQueueJson(room, 20) }),
            selectedContent: chosenCandidate.title,
            originalIntent: plan.originalIntent,
          });
          finalResult = { query, selection: candidateSelection, verified, afterStatus, afterQueueJson };
          break;
        } catch (error) {
          emit({
            phase: 'candidate-failed',
            query,
            chosenCandidate,
            message: error?.message || String(error),
            code: error?.code || null,
            retryNextCandidate: shouldRetryWithNextCandidate(error),
            retryNextQuery: shouldRetryWithNextQuery(error),
            data: error?.data || null,
          });
          lastError = error;
          if (shouldRetryWithNextCandidate(error)) {
            runner.recoverSearchPageVerified(targetId, query, { settleMs: 250 });
            ensureFreshSearchResults(runner, targetId, query, { settleMs: QUERY_GATE_RETRY_SETTLE_MS, recoverySettleMs: 250 });
            continue;
          }
          throw error;
        }
      }

      if (finalResult) break;
    } catch (error) {
      emit({
        phase: 'query-failed',
        query,
        message: error?.message || String(error),
        code: error?.code || null,
        retryNextQuery: shouldRetryWithNextQuery(error),
        data: error?.data || null,
      });
      lastError = error;
      if (!shouldRetryWithNextQuery(error)) break;
    }
  }

  if (!finalResult) {
    throw lastError || new Error('Playback run failed without final result');
  }

  const closeResidentResult = closeRunnerForExit('browser-runner-closed');

  const successPayload = {
    ok: true,
    report: {
      topCandidate: finalResult.selection.report.topRecommended,
      chosenCandidate: finalResult.selection.report.chosen,
      deviation: finalResult.selection.report.deviation,
      decisionReason: finalResult.selection.report.decisionReason,
      playbackVerifyResult: finalResult.verified,
    },
  };
  const successScreenshot = captureSuccessScreenshot(runner, targetId);
  appendRunRecord({
    kind: 'run-succeeded',
    room,
    request,
    query: finalResult.query,
    chosenCandidate: finalResult.selection.report.chosen,
    playbackVerifyResult: finalResult.verified,
    successScreenshotPath: successScreenshot?.savedPath || null,
  });
  try {
    const notifyResult = notifySuccessArtifact({
      capturedAt: new Date().toISOString(),
      room,
      request,
      query: finalResult.query,
      targetId,
      screenshotPath: successScreenshot?.savedPath || null,
      chosenCandidate: finalResult.selection.report.chosen,
      playbackVerifyResult: finalResult.verified,
    });
    appendRunRecord({ kind: 'success-notified', notifyResult, screenshotPath: successScreenshot?.savedPath || null });
  } catch (notifyError) {
    appendRunRecord({
      kind: 'success-notify-failed',
      message: String(notifyError?.message || notifyError),
      screenshotPath: successScreenshot?.savedPath || null,
    });
  }
  console.log(JSON.stringify(successPayload));
} catch (error) {
  closeRunnerForExit('browser-runner-closed-after-error');
  fail('run-live-once', error, { room: roomInput, request });
}
