#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import { analyzeIntent } from './intent.mjs';
import {
  applyControlSteps,
  ensureSoloRoom,
  getGroupStatus,
  getQueue,
  getStatus,
  resolveRoom,
} from './cli-control.mjs';
import { PurePlayBrowserRunner } from './browser-runner.mjs';
import { SkillError } from './normalize.mjs';
import { loadPlaybackHistory, recordSuccessfulPlayback } from './playback-memory.mjs';
import { buildQueryPlan } from './query-planner.mjs';
import { SONOS_URL } from './selectors.mjs';
import { runMediaFlow } from './web-flow.mjs';
import { verifyMediaPlayback } from './verify.mjs';

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function fail(error) {
  if (error instanceof SkillError) {
    emit({ ok: false, phase: error.phase, code: error.code, message: error.message, ...error.data, final: true });
    process.exit(1);
  }

  emit({
    ok: false,
    phase: 'runtime',
    code: 'UNHANDLED_ERROR',
    message: String(error?.message || error),
    final: true,
  });
  process.exit(1);
}

async function main() {
  const request = process.argv[2] || '';
  const roomInput = process.argv[3] || '';
  const requestedMode = process.argv[4] || 'replace-first';
  const browserProfile = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw';

  if (!request || !roomInput) {
    throw new SkillError(
      'bootstrap',
      'USAGE',
      'Usage: node scripts/run.mjs <request-or-query> <room> [replace-first|append-first|play-now]'
    );
  }

  const intent = analyzeIntent({ request, requestedMode });
  emit({
    ok: true,
    phase: 'intent',
    intentKind: intent.kind,
    requestedMode,
    actionPreference: intent.actionPreference,
    mediaRequest: intent.mediaRequest || null,
    controlSteps: intent.controlSteps || [],
  });

  const room = resolveRoom(roomInput);
  emit({ ok: true, phase: 'resolve-room', roomInput, room });

  const groupStatus = getGroupStatus();
  const groupNormalization = ensureSoloRoom(room, groupStatus);
  emit({
    ok: true,
    phase: 'group-normalize',
    room,
    changed: groupNormalization.changed,
    beforeGroupStatus: groupNormalization.before,
    afterGroupStatus: groupNormalization.after,
  });
  const normalizedGroupStatus = groupNormalization.after;

  if (intent.kind === 'CONTROL_ONLY') {
    const controlResults = applyControlSteps(room, intent.controlSteps);
    emit({
      ok: true,
      phase: 'control-only',
      room,
      groupStatus: normalizedGroupStatus,
      controlResults,
      final: true,
    });
    return;
  }

  const queryPlan = buildQueryPlan({ request: intent.mediaRequest || intent.request });
  emit({
    ok: true,
    phase: 'query-plan',
    intent: queryPlan.intent,
    originalIntent: queryPlan.originalIntent,
    requestKind: queryPlan.requestKind,
    queryMode: queryPlan.queryMode || 'legacy',
    queries: queryPlan.queries,
    strategy: queryPlan.strategy,
    allowedTypes: queryPlan.allowedTypes,
    flowHints: queryPlan.flowHints,
  });

  const preStatus = getStatus(room);
  const preQueue = getQueue(room);
  emit({
    ok: true,
    phase: 'preflight',
    room,
    state: preStatus.state || null,
    title: preStatus.title || null,
    track: preStatus.track || null,
    group: preStatus.group || null,
    groupStatus: normalizedGroupStatus,
  });

  const runner = new PurePlayBrowserRunner({
    profile: browserProfile,
    logger: emit,
    baseUrl: SONOS_URL,
  });
  emit({ ok: true, phase: 'mcp-profile', browserProfile });
  const playbackHistory = loadPlaybackHistory();
  emit({ ok: true, phase: 'playback-history', count: playbackHistory.length });

  const webResult = runMediaFlow({
    runner,
    queryPlan,
    room,
    actionPreference: intent.actionPreference,
    playbackHistory,
    log: emit,
  });
  emit({ ok: true, phase: 'web-flow', room, ...webResult });

  const postStatus = getStatus(room);
  const postQueue = getQueue(room);
  await delay(4000);
  const followupStatus = getStatus(room);

  let verification;
  try {
    verification = verifyMediaPlayback({
      room,
      query: webResult.query,
      selectedContent: webResult.selectedContent,
      actionName: webResult.actionName,
      preStatus,
      postStatus,
      followupStatus,
      preQueue,
      postQueue,
      retryPlay: () => {
        applyControlSteps(room, ['play']);
        return getStatus(room);
      },
    });
  } catch (error) {
    if (error instanceof SkillError && error.code === 'CLI_VERIFY_FAILED') {
      error.data = {
        ...error.data,
        webRoomContext: runner.readRoomContext(webResult.targetId),
      };
    }
    throw error;
  }

  emit({
    ok: true,
    phase: 'verify-cli',
    room,
    verification,
  });

  const historyEntry = recordSuccessfulPlayback({
    room,
    originalIntent: queryPlan.originalIntent,
    queryUsed: webResult.query,
    selectedTitle: webResult.selectedContent,
    selectedType: webResult.selectedType || 'unknown',
    actionName: webResult.actionName,
    finalTitle: verification.finalTitle,
    finalTrack: verification.finalTrack,
    verify: 'success',
  });
  emit({
    ok: true,
    phase: 'playback-history-write',
    room,
    historyEntry,
  });

  const postControlResults = intent.controlSteps?.length ? applyControlSteps(room, intent.controlSteps) : [];
  emit({
    ok: true,
    phase: 'post-control',
    room,
    controlResults: postControlResults,
    final: true,
  });
}

main().catch(fail);
