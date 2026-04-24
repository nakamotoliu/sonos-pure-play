import { normalizeWhitespace } from './normalize.mjs';

export function normalizeRoomText(value) {
  return normalizeWhitespace(String(value || ''));
}

export function buildRoomLabels(room) {
  const targetRoom = normalizeRoomText(room);
  return {
    targetRoom,
    activateLabel: `将${targetRoom}设置为有效`,
    playGroupLabel: `播放群组${targetRoom}`,
    pauseGroupLabel: `暂停群组${targetRoom}`,
    outputSelectorLabel: '输出选择器',
  };
}

export function labelsMentioningOtherRooms(labels = [], room) {
  const { targetRoom } = buildRoomLabels(room);
  return labels
    .map(normalizeRoomText)
    .filter((label) => /^(将.+设置为有效|播放群组.+|暂停群组.+)$/.test(label))
    .filter((label) => !label.includes(targetRoom));
}

export function classifyRoomActiveState({ room, labels = [], text = '', nowPlayingText = '' } = {}) {
  const roomLabels = buildRoomLabels(room);
  const normalizedLabels = (Array.isArray(labels) ? labels : [])
    .map(normalizeRoomText)
    .filter(Boolean);
  const normalizedText = normalizeRoomText(text);
  const normalizedNowPlayingText = normalizeRoomText(nowPlayingText);
  const otherRoomControls = labelsMentioningOtherRooms(normalizedLabels, roomLabels.targetRoom);

  const hasActivate = normalizedLabels.includes(roomLabels.activateLabel);
  const hasPlayGroup = normalizedLabels.includes(roomLabels.playGroupLabel);
  const hasPauseGroup = normalizedLabels.includes(roomLabels.pauseGroupLabel);
  const hasOutputSelector = normalizedLabels.includes(roomLabels.outputSelectorLabel);
  const mentionsRoom = normalizedText.includes(roomLabels.targetRoom)
    || normalizedLabels.some((label) => label.includes(roomLabels.targetRoom));
  const mixedRoomCard = otherRoomControls.length > 0;
  const nowPlayingMatchesRoom = normalizedNowPlayingText.includes(roomLabels.targetRoom);

  // Sonos Web active output is a page-only concept. The strongest signal is the
  // persistent “正在播放” area naming the target room. System-list controls can
  // coexist with active playback and are only secondary signals.
  const activeRoomConfirmed = nowPlayingMatchesRoom || (
    mentionsRoom
    && !mixedRoomCard
    && !hasActivate
    && (hasOutputSelector || hasPlayGroup || hasPauseGroup)
  );

  return {
    targetRoom: roomLabels.targetRoom,
    activeRoomConfirmed,
    hasActivate,
    hasPlayGroup,
    hasPauseGroup,
    hasOutputSelector,
    mentionsRoom,
    mixedRoomCard,
    otherRoomControls,
    nowPlayingMatchesRoom,
    activeControls: normalizedLabels.filter((label) => (
      label === roomLabels.outputSelectorLabel
      || label === roomLabels.playGroupLabel
      || label === roomLabels.pauseGroupLabel
    )),
    reason: activeRoomConfirmed
      ? (nowPlayingMatchesRoom ? 'page-now-playing-room' : 'page-active-room-controls')
      : mixedRoomCard
        ? 'mixed-room-card-not-valid'
        : hasActivate
          ? 'page-offers-set-active'
          : 'page-active-room-not-confirmed',
  };
}
