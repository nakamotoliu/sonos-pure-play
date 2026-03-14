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
}) {
  if (!groupIncludesRoom(postStatus.group, room)) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Target room is not present in the Sonos group reported after playback.', {
      room,
      group: postStatus.group,
    });
  }

  if (String(followupStatus.state || '').toUpperCase() !== 'PLAYING') {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI did not confirm PLAYING after the web action.', {
      room,
      state: followupStatus.state || null,
      title: followupStatus.title || null,
      track: followupStatus.track || null,
      actionName,
    });
  }

  const queueChanged = preQueue !== postQueue || getQueueCount(postQueue) !== getQueueCount(preQueue);
  const prePosition = parseTimeToSeconds(postStatus.position);
  const followupPosition = parseTimeToSeconds(followupStatus.position);
  const progressAdvanced = prePosition !== null && followupPosition !== null && followupPosition > prePosition;
  const titleChanged = normalizeText(preStatus.title) !== normalizeText(followupStatus.title);
  const trackChanged = normalizeText(preStatus.track) !== normalizeText(followupStatus.track);
  const relevantTitle = titleLooksRelevant({ query, selectedContent, postStatus: followupStatus });

  if (!queueChanged && !progressAdvanced && !titleChanged && !trackChanged) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'CLI status changed too little to prove playback moved to the requested content.', {
      room,
      actionName,
      preTitle: preStatus.title || null,
      postTitle: followupStatus.title || null,
      preTrack: preStatus.track || null,
      postTrack: followupStatus.track || null,
    });
  }

  return {
    actionName,
    queueChanged,
    progressAdvanced,
    titleChanged,
    trackChanged,
    relevantTitle,
    finalState: followupStatus.state || null,
    finalTitle: followupStatus.title || null,
    finalTrack: followupStatus.track || null,
  };
}
