import { getQueueCount, normalizeText, parseTimeToSeconds, SkillError } from './normalize.mjs';

function groupIncludesRoom(group, room) {
  if (!group) return true;
  return group.toLowerCase().includes(room.toLowerCase());
}

function titleLooksRelevant({ query, selectedContent, postStatus }) {
  const haystack = normalizeText([postStatus.title, postStatus.track].filter(Boolean).join(' '));
  const tokens = normalizeText(`${query} ${selectedContent || ''}`).split(' ').filter(Boolean);
  if (!haystack || !tokens.length) return false;
  return tokens.some((token) => haystack.includes(token));
}

function queueLooksChanged(preQueue, postQueue) {
  return preQueue !== postQueue || getQueueCount(postQueue) !== getQueueCount(preQueue);
}

export function verifyMediaPlayback({
  room,
  query,
  selectedContent,
  actionName,
  preStatus,
  postStatus,
  followupStatus,
  preQueue,
  postQueue,
  retryPlay,
}) {
  let effectiveFollowupStatus = followupStatus;
  if (!groupIncludesRoom(postStatus.group, room)) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Target room is not present in the Sonos group reported after playback.', {
      room,
      group: postStatus.group,
    });
  }

  if (String(effectiveFollowupStatus.state || '').toUpperCase() !== 'PLAYING') {
    if (typeof retryPlay === 'function') {
      const retried = retryPlay();
      if (String(retried?.state || '').toUpperCase() === 'PLAYING') {
        effectiveFollowupStatus = retried;
      }
    }
  }

  if (String(effectiveFollowupStatus.state || '').toUpperCase() !== 'PLAYING') {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI did not confirm PLAYING after the web action.', {
      room,
      state: effectiveFollowupStatus.state || null,
      title: effectiveFollowupStatus.title || null,
      track: effectiveFollowupStatus.track || null,
      actionName,
    });
  }

  const queueChanged = queueLooksChanged(preQueue, postQueue);
  const prePosition = parseTimeToSeconds(postStatus.position);
  const followupPosition = parseTimeToSeconds(followupStatus.position);
  const progressAdvanced = prePosition !== null && followupPosition !== null && followupPosition > prePosition;
  const titleChanged = normalizeText(preStatus.title) !== normalizeText(effectiveFollowupStatus.title);
  const trackChanged = normalizeText(preStatus.track) !== normalizeText(effectiveFollowupStatus.track);
  const relevantTitle = titleLooksRelevant({ query, selectedContent, postStatus: effectiveFollowupStatus });

  const acceptedByQueueProof = queueChanged;
  const acceptedByFallbackSignals = progressAdvanced || titleChanged || trackChanged;

  if (!acceptedByQueueProof && !acceptedByFallbackSignals) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'CLI status changed too little to prove playback moved to the requested content.', {
      room,
      actionName,
      preTitle: preStatus.title || null,
      postTitle: effectiveFollowupStatus.title || null,
      preTrack: preStatus.track || null,
      postTrack: effectiveFollowupStatus.track || null,
      preQueueCount: getQueueCount(preQueue),
      postQueueCount: getQueueCount(postQueue),
    });
  }

  return {
    actionName,
    queueChanged,
    progressAdvanced,
    titleChanged,
    trackChanged,
    relevantTitle,
    acceptedBy: acceptedByQueueProof ? 'queue-proof' : 'fallback-signals',
    finalState: effectiveFollowupStatus.state || null,
    finalTitle: effectiveFollowupStatus.title || null,
    finalTrack: effectiveFollowupStatus.track || null,
  };
}
