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

function clickCandidate(runner, targetId, chosen) {
  const playLabel = chosen?.playLabel || '';
  if (!playLabel) throw new Error('chosen candidate has no playLabel');
  const clicked = runner.clickButtonByLabel(targetId, [playLabel]);
  if (!clicked?.ok) throw new Error(`candidate click failed: ${playLabel}`);
  return clicked;
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
const runner = new PurePlayBrowserRunner({ logger, profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw' });

let finalizedBySignal = false;
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
  appendRunRecord({
    kind: 'run-signaled',
    signal,
    step,
    targetId: runner.currentTargetId || null,
    context: runner.currentStepContext || null,
    evidence,
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

  const roomSync = runner.runStep('room-sync-read-before', {
    targetId,
    context: { room },
    action: () => runner.readRoomSyncState(targetId, room),
    verify: (result) => ({ ok: Boolean(result?.roomVisible || result?.roomCardFound), result }),
  }).actionResult;
  emit({ phase: 'room-sync-before', roomSync });
  if (!roomSync?.activeRoomConfirmed) {
    const activate = runner.runStep('room-sync-activate', {
      targetId,
      context: { room },
      action: () => runner.clickRoomActivate(targetId, room),
      verify: (result) => ({ ok: Boolean(result?.ok), result }),
    }).actionResult;
    emit({ phase: 'room-sync-click', activate });
    runner.waitMs(800);
  }
  const roomSyncAfter = runner.runStep('room-sync-read-after', {
    targetId,
    context: { room },
    action: () => runner.readRoomSyncState(targetId, room),
    verify: (result) => ({ ok: Boolean(result?.activeRoomConfirmed || result?.roomCardFound), result }),
  }).actionResult;
  emit({ phase: 'room-sync-after', roomSyncAfter });

  let finalResult = null;
  let lastError = null;

  for (const query of plan.queries.slice(0, 3)) {
    emit({ phase: 'query-attempt', query });

    try {
      runner.navigateVerified(targetId, 'https://play.sonos.com/zh-cn/search', { settleMs: 1200 });
      const queryGate = runner.ensureQueryGateVerified(targetId, query, { pageReloads: 1, inputAttempts: 2, settleMs: 1400 }).actionResult;
      emit({ phase: 'query-gate', query, queryGate });

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
              const clicked = clickCandidate(runner, targetId, chosenCandidate);
              runner.waitForLoad(targetId);
              runner.waitMs(1000);
              return {
                clicked,
                state: runner.readPageState(targetId),
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

          const playbackAction = runner.choosePlaybackActionVerified(targetId, actionNames, { waitMs: 400 }).actionResult;
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
            runner.navigateVerified(targetId, 'https://play.sonos.com/zh-cn/search', { settleMs: 900 });
            runner.ensureQueryGateVerified(targetId, query, { pageReloads: 0, inputAttempts: 1, settleMs: 800 });
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
  fail('run-live-once', error, { room: roomInput, request });
}
