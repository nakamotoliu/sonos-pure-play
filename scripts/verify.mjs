import { normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';

export const MAX_PLAYBACK_ATTEMPTS = 3;

function buildRetryMeta(reason, retryable) {
  return {
    retryable: Boolean(retryable),
    retryReason: reason || null,
  };
}

export function isRetryablePlaybackVerificationFailure(error) {
  return Boolean(error?.phase === 'verify-cli' && error?.data?.retryable);
}

function groupIncludesRoom(group, room) {
  if (!group) return true;
  return String(group).toLowerCase().includes(String(room).toLowerCase());
}

function titleMatchesIntent(finalTitle, selectedContent, originalIntent) {
  const finalKey = normalizeText(finalTitle || '');
  const selectedKey = normalizeText(selectedContent || '');
  const intentKey = normalizeText(originalIntent || '');
  if (!finalKey) return false;
  return Boolean(
    (selectedKey && (finalKey.includes(selectedKey) || selectedKey.includes(finalKey))) ||
    (intentKey && (finalKey.includes(intentKey) || intentKey.includes(finalKey)))
  );
}

export function verifyMediaPlayback({
  room,
  actionName,
  postStatus,
  followupStatus,
  followupQueueJson,
  retryPlay,
  retrySnapshot,
  selectedContent,
  originalIntent,
}) {
  let effectiveStatus = followupStatus;
  let effectiveQueueJson = followupQueueJson;

  if (!groupIncludesRoom(postStatus.group, room)) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Target room is not present in the Sonos CLI group reported after playback.', {
      room,
      group: postStatus.group || null,
      ...buildRetryMeta('group-mismatch', false),
    });
  }

  if (String(effectiveStatus?.state || '').toUpperCase() !== 'PLAYING' && typeof retryPlay === 'function') {
    retryPlay();
    if (typeof retrySnapshot === 'function') {
      const snapshot = retrySnapshot();
      if (snapshot?.status) effectiveStatus = snapshot.status;
      if (snapshot?.queueJson) effectiveQueueJson = snapshot.queueJson;
    }
  }

  if (String(effectiveStatus?.state || '').toUpperCase() !== 'PLAYING') {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI did not confirm PLAYING after the web action.', {
      room,
      actionName,
      finalState: effectiveStatus?.state || null,
      finalTitle: effectiveStatus?.title || null,
      finalTrack: effectiveStatus?.track || null,
      ...buildRetryMeta('not-playing-after-action', true),
    });
  }

  const finalTitle = normalizeWhitespace(effectiveStatus?.title || '');
  const previousTitle = normalizeWhitespace(postStatus?.title || '');
  const finalTrack = normalizeWhitespace(effectiveStatus?.track || '');
  const previousTrack = normalizeWhitespace(postStatus?.track || '');
  const queueItems = Array.isArray(effectiveQueueJson?.items) ? effectiveQueueJson.items.length : 0;
  const titleChanged = Boolean(finalTitle && finalTitle !== previousTitle);
  const trackChanged = Boolean(finalTrack && finalTrack !== previousTrack);
  const intentMatched = titleMatchesIntent(finalTitle, selectedContent, originalIntent);

  const cliSignals = {
    playing: true,
    queueItems,
    titleChanged,
    trackChanged,
    intentMatched,
  };

  if (!queueItems && !titleChanged && !trackChanged && !intentMatched) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI reported PLAYING, but it did not expose a queue, a track change, or a title match with the requested content.', {
      room,
      actionName,
      cliSignals,
      previousTitle: previousTitle || null,
      finalTitle: finalTitle || null,
      previousTrack: previousTrack || null,
      finalTrack: finalTrack || null,
      selectedContent: selectedContent || null,
      originalIntent: originalIntent || null,
      ...buildRetryMeta('playing-without-content-match', true),
    });
  }

  return {
    actionName,
    playbackSuccess: true,
    executionMatched: true,
    matchedBy: intentMatched
      ? 'cli-title-match'
      : titleChanged || trackChanged
        ? 'cli-track-change'
        : 'cli-queue-present',
    cliSignals,
    finalState: effectiveStatus?.state || null,
    finalTitle: finalTitle || null,
    finalTrack: finalTrack || null,
  };
}
