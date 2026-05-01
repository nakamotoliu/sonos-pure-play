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

export function classifyRoomActiveState({ room, labels = [], text = '', nowPlayingText = '', selected = false, pressedLabels = [] } = {}) {
  const roomLabels = buildRoomLabels(room);
  const normalizedLabels = (Array.isArray(labels) ? labels : [])
    .map(normalizeRoomText)
    .filter(Boolean);
  const normalizedText = normalizeRoomText(text);
  const normalizedNowPlayingText = normalizeRoomText(nowPlayingText);
  const normalizedPressedLabels = (Array.isArray(pressedLabels) ? pressedLabels : [])
    .map(normalizeRoomText)
    .filter(Boolean);
  const otherRoomControls = labelsMentioningOtherRooms(normalizedLabels, roomLabels.targetRoom);

  const hasActivate = normalizedLabels.includes(roomLabels.activateLabel);
  const hasPlayGroup = normalizedLabels.includes(roomLabels.playGroupLabel);
  const hasPauseGroup = normalizedLabels.includes(roomLabels.pauseGroupLabel);
  const hasOutputSelector = normalizedLabels.includes(roomLabels.outputSelectorLabel);
  const mentionsRoom = normalizedText.includes(roomLabels.targetRoom)
    || normalizedLabels.some((label) => label.includes(roomLabels.targetRoom));
  const mixedRoomCard = otherRoomControls.length > 0;
  const nowPlayingMatchesRoom = normalizedNowPlayingText.includes(roomLabels.targetRoom);
  const hasPressedGroupControl = normalizedPressedLabels.includes(roomLabels.playGroupLabel)
    || normalizedPressedLabels.includes(roomLabels.pauseGroupLabel);

  // Sonos Web active output is a side-bar/system-view concept. Bottom
  // “正在播放” can prove sound is coming from a room, but it must not select
  // the browser operation target. Only the side-bar room card state can confirm
  // the active room.
  const activeRoomConfirmed = Boolean(
    mentionsRoom
    && !mixedRoomCard
    && !hasActivate
    && (
      selected
      || hasPressedGroupControl
      || (!hasOutputSelector && (hasPlayGroup || hasPauseGroup))
    )
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
    selected,
    hasPressedGroupControl,
    activeControls: normalizedLabels.filter((label) => (
      label === roomLabels.outputSelectorLabel
      || label === roomLabels.playGroupLabel
      || label === roomLabels.pauseGroupLabel
    )),
    reason: activeRoomConfirmed
      ? (selected ? 'sidebar-selected-room-card' : hasPressedGroupControl ? 'sidebar-pressed-room-control' : 'sidebar-active-room-controls')
      : mixedRoomCard
        ? 'mixed-room-card-not-valid'
        : hasActivate
          ? 'page-offers-set-active'
          : 'page-active-room-not-confirmed',
  };
}
