import { normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';

export const MAX_PLAYBACK_ATTEMPTS = 3;

const COPYRIGHT_UNAVAILABLE_PATTERNS = [
  /应版权方要求暂不能播放/,
  /版权方要求暂不能播放/,
  /暂不能播放/,
  /无法播放/,
  /unavailable/i,
  /not available/i,
  /copyright/i,
];

function buildRetryMeta(reason, retryable) {
  return {
    retryable: Boolean(retryable),
    retryReason: reason || null,
  };
}

export function isRetryablePlaybackVerificationFailure(error) {
  return Boolean(error?.phase === 'verify-cli' && error?.data?.retryable);
}

export function textLooksCopyrightUnavailable(text) {
  const value = String(text || '');
  return COPYRIGHT_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(value));
}

function queueUnavailableEvidence(queueJson) {
  const items = Array.isArray(queueJson?.items) ? queueJson.items : [];
  const unavailableItems = [];
  for (const entry of items) {
    const item = entry?.item || entry || {};
    const text = [
      item.title,
      item.artist,
      item.album,
      item.uri,
      entry.title,
      entry.artist,
      entry.album,
      entry.uri,
    ].filter(Boolean).join(' ');
    if (textLooksCopyrightUnavailable(text)) {
      unavailableItems.push({
        position: entry?.position ?? null,
        title: item.title || entry.title || null,
        artist: item.artist || entry.artist || null,
        album: item.album || entry.album || null,
      });
    }
  }
  return unavailableItems;
}

function statusUnavailableEvidence(status) {
  const text = [status?.title, status?.artist, status?.album, status?.raw].filter(Boolean).join(' ');
  return textLooksCopyrightUnavailable(text)
    ? {
        title: status?.title || null,
        artist: status?.artist || null,
        album: status?.album || null,
      }
    : null;
}

function groupIncludesRoom(group, room) {
  if (!group) return true;
  return String(group).toLowerCase().includes(String(room).toLowerCase());
}

function titleMatchesIntent(finalTitle, selectedContent, originalIntent, followupQueueJson) {
  const finalKey = normalizeText(finalTitle || '');
  const selectedKey = normalizeText(selectedContent || '');
  const intentKey = normalizeText(originalIntent || '');
  if (!finalKey) return false;
  if (
    (selectedKey && (finalKey.includes(selectedKey) || selectedKey.includes(finalKey))) ||
    (intentKey && (finalKey.includes(intentKey) || intentKey.includes(finalKey)))
  ) {
    return true;
  }
  const queueText = normalizeText(JSON.stringify(followupQueueJson || {}));
  return Boolean(
    queueText && (
      (selectedKey && queueText.includes(selectedKey)) ||
      (intentKey && queueText.includes(intentKey))
    )
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

  let retryPlayError = null;
  let retrySnapshotError = null;

  if (String(effectiveStatus?.state || '').toUpperCase() !== 'PLAYING' && typeof retryPlay === 'function') {
    try {
      retryPlay();
    } catch (error) {
      retryPlayError = error;
    }
    if (typeof retrySnapshot === 'function') {
      try {
        const snapshot = retrySnapshot();
        if (snapshot?.status) effectiveStatus = snapshot.status;
        if (snapshot?.queueJson) effectiveQueueJson = snapshot.queueJson;
      } catch (error) {
        retrySnapshotError = error;
      }
    }
  }

  if (String(effectiveStatus?.state || '').toUpperCase() !== 'PLAYING') {
    const unavailableStatus = statusUnavailableEvidence(effectiveStatus);
    const unavailableQueueItems = queueUnavailableEvidence(effectiveQueueJson);
    const unavailableEvidence = unavailableStatus || unavailableQueueItems.length
      ? { unavailableStatus, unavailableQueueItems }
      : null;
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI did not confirm PLAYING after the web action.', {
      room,
      actionName,
      finalState: effectiveStatus?.state || null,
      finalTitle: effectiveStatus?.title || null,
      finalTrack: effectiveStatus?.track || null,
      unavailableEvidence,
      retryPlayError: retryPlayError ? {
        phase: retryPlayError?.phase || null,
        code: retryPlayError?.code || null,
        message: retryPlayError?.message || String(retryPlayError),
        data: retryPlayError?.data || null,
      } : null,
      retrySnapshotError: retrySnapshotError ? {
        phase: retrySnapshotError?.phase || null,
        code: retrySnapshotError?.code || null,
        message: retrySnapshotError?.message || String(retrySnapshotError),
        data: retrySnapshotError?.data || null,
      } : null,
      ...buildRetryMeta(unavailableEvidence ? 'copyright-unavailable' : 'not-playing-after-action', true),
    });
  }

  const finalTitle = normalizeWhitespace(effectiveStatus?.title || '');
  const previousTitle = normalizeWhitespace(postStatus?.title || '');
  const finalTrack = normalizeWhitespace(effectiveStatus?.track || '');
  const previousTrack = normalizeWhitespace(postStatus?.track || '');
  const queueItems = Array.isArray(effectiveQueueJson?.items) ? effectiveQueueJson.items.length : 0;
  const titleChanged = Boolean(finalTitle && finalTitle !== previousTitle);
  const trackChanged = Boolean(finalTrack && finalTrack !== previousTrack);
  const intentMatched = titleMatchesIntent(finalTitle, selectedContent, originalIntent, effectiveQueueJson);

  const cliSignals = {
    playing: true,
    queueItems,
    titleChanged,
    trackChanged,
    intentMatched,
  };

  if (!intentMatched) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI reported PLAYING, but the playing title does not match the selected/requested content.', {
      room,
      actionName,
      cliSignals,
      previousTitle: previousTitle || null,
      finalTitle: finalTitle || null,
      previousTrack: previousTrack || null,
      finalTrack: finalTrack || null,
      selectedContent: selectedContent || null,
      originalIntent: originalIntent || null,
      ...buildRetryMeta(titleChanged || trackChanged ? 'playing-content-mismatch' : 'playing-without-content-match', true),
    });
  }

  return {
    actionName,
    playbackSuccess: true,
    executionMatched: true,
    matchedBy: intentMatched
      ? 'cli-title-match'
      : 'cli-track-change',
    cliSignals,
    finalState: effectiveStatus?.state || null,
    finalTitle: finalTitle || null,
    finalTrack: finalTrack || null,
  };
}
