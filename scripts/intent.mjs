import { SkillError, normalizeWhitespace } from './normalize.mjs';
import { DEFAULT_ACTION, VALID_ACTIONS } from './selectors.mjs';

const MEDIA_HINTS = ['播放', '放', '想听', '搜索', '搜', '找', '歌单', '列表', '专辑', '艺术家', '歌曲', '音乐'];
const CONTROL_HINTS = ['暂停', '继续', '恢复', '下一首', '上一首', '音量', '静音', '停止', '分组', '切换房间', 'solo', 'unjoin'];
const ROOM_WORDS = ['客厅', '卧室', '工作室', '厨房', '书房'];

export function analyzeIntent({ request, requestedMode }) {
  const normalizedRequest = normalizeWhitespace(request);
  if (!normalizedRequest) {
    throw new SkillError('intent', 'EMPTY_REQUEST', 'Request is empty after normalization.');
  }

  const actionPreference = VALID_ACTIONS.has(requestedMode) ? requestedMode : DEFAULT_ACTION;
  const controlSteps = extractControlSteps(normalizedRequest);
  const mediaRequest = cleanMediaRequest(removeControlFragments(normalizedRequest, controlSteps));
  const hasMediaHint = MEDIA_HINTS.some((keyword) => mediaRequest.includes(keyword));
  const hasControlHint = controlSteps.length > 0 || CONTROL_HINTS.some((keyword) => normalizedRequest.includes(keyword));

  if (hasControlHint && !mediaRequest) {
    return {
      kind: 'CONTROL_ONLY',
      request: normalizedRequest,
      mediaRequest: '',
      controlSteps,
      actionPreference,
    };
  }

  return {
    kind: 'MEDIA_FLOW',
    request: normalizedRequest,
    mediaRequest: mediaRequest || normalizedRequest,
    controlSteps,
    actionPreference,
    hasMediaHint,
  };
}

function extractControlSteps(request) {
  const steps = [];
  const volumeMatch = request.match(/音量\s*([0-9]{1,3})/);
  if (volumeMatch) {
    steps.push({ kind: 'volume', value: Number(volumeMatch[1]), raw: volumeMatch[0] });
  }

  const patterns = [
    { kind: 'pause', regex: /(暂停|停一下|先停)/ },
    { kind: 'play', regex: /(继续播放|继续|恢复播放|恢复)/ },
    { kind: 'next', regex: /(下一首|下首|切下一首)/ },
    { kind: 'prev', regex: /(上一首|上首|切上一首)/ },
    { kind: 'stop', regex: /(停止播放|停止)/ },
    { kind: 'mute', regex: /(静音)/ },
  ];

  for (const entry of patterns) {
    const match = request.match(entry.regex);
    if (match) {
      steps.push({ kind: entry.kind, raw: match[0] });
    }
  }

  return steps;
}

function removeControlFragments(request, controlSteps) {
  let text = request;
  for (const step of controlSteps) {
    if (step.raw) {
      text = text.replace(step.raw, ' ');
    }
  }
  return normalizeWhitespace(text);
}

function cleanMediaRequest(request) {
  let text = normalizeWhitespace(request);
  for (const roomWord of ROOM_WORDS) {
    text = text.replace(new RegExp(roomWord, 'g'), ' ');
  }
  text = text
    .replace(/^(在)?\s*/g, '')
    .replace(/(给我|帮我|请|麻烦|一下|吧)$/g, ' ')
    .replace(/^(播放|放|听|来点|来首|来一首)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeWhitespace(text);
}
