import { normalizeWhitespace } from './normalize.mjs';

const LEADING_INTENT_PREFIX = /^(请|麻烦|帮我|给我|让我|想听|我想听|我想要|我要|在[^ ]+?(播放|放|搜|搜索|找)|在[^ ]+?听|替我|帮忙)?/;
const LEADING_ACTION_PREFIX = /^(播放|放一下|放一首|放点|放|搜一下|搜索一下|搜索|搜|找一下|找|听一下|听|来一首|来点|来点儿|来首|来个|整点)/;
const TRAILING_FILLERS = /(吧|一下|一点|一些|谢谢|好吗|可以吗)$/g;

const SCENE_SYNONYMS = [
  { pattern: /放松|chill|轻松/, terms: ['放松', '轻音乐', '治愈'] },
  { pattern: /提神|打起精神|醒脑/, terms: ['提神', '活力', '热歌'] },
  { pattern: /睡觉|睡前|助眠|入睡/, terms: ['助眠', '睡眠', '轻音乐'] },
  { pattern: /专注|学习|工作|办公/, terms: ['专注', '学习', '纯音乐'] },
];

export function buildQueryPlan({ request }) {
  const normalizedRequest = normalizeWhitespace(request);
  const intent = cleanIntent(normalizedRequest) || normalizedRequest;
  const queries = dedupe([
    ...buildExactFirstCandidates(intent),
    ...buildHeuristicCandidates(intent),
    ...buildSceneCandidates(intent),
  ]).slice(0, 4);

  return {
    request: normalizedRequest,
    intent,
    queries,
  };
}

function cleanIntent(value) {
  return normalizeWhitespace(
    value
      .replace(LEADING_INTENT_PREFIX, '')
      .replace(LEADING_ACTION_PREFIX, '')
      .replace(TRAILING_FILLERS, '')
  );
}

function buildExactFirstCandidates(intent) {
  const candidates = [];
  if (!intent) return candidates;

  candidates.push(intent);

  const artistHotMatch = intent.match(/^(.+?)(的)?(热歌|热门|热门精选)$/);
  if (artistHotMatch) {
    const artist = normalizeWhitespace(artistHotMatch[1]);
    candidates.push(`${artist} 热门精选`);
    candidates.push(`${artist} 热歌`);
    candidates.push(artist);
    return candidates;
  }

  const explicitTypeMatch = intent.match(/^(.+?)\s*(歌单|播放列表|列表|专辑|歌曲|单曲)$/);
  if (explicitTypeMatch) {
    const subject = normalizeWhitespace(explicitTypeMatch[1]);
    const type = explicitTypeMatch[2];
    candidates.push(subject);
    if (type === '歌单' || type === '播放列表' || type === '列表') {
      candidates.push(`${subject} 精选`);
    }
    if (type === '专辑') {
      candidates.push(`${subject} 专辑`);
    }
  }

  const artistSongMatch = intent.match(/^(.+?)\s+(.+?)$/);
  if (artistSongMatch && !/热歌|热门|精选|歌单|播放列表|专辑/.test(intent)) {
    const left = normalizeWhitespace(artistSongMatch[1]);
    const right = normalizeWhitespace(artistSongMatch[2]);
    candidates.push(`${left} ${right}`);
    candidates.push(`${right} ${left}`);
  }

  return candidates;
}

function buildHeuristicCandidates(intent) {
  const candidates = [];
  if (!intent) return candidates;

  const stripped = normalizeWhitespace(
    intent
      .replace(/(音乐|歌曲|听歌|来点歌)/g, '')
      .replace(/的(?=(热歌|热门|热门精选|歌单|播放列表|专辑|音乐)$)/g, ' ')
      .replace(/(一下|一点)/g, ' ')
      .replace(/的$/g, ' ')
  );

  if (stripped && stripped !== intent) {
    candidates.push(stripped);
  }

  if (/热门精选/.test(intent)) {
    candidates.push(intent.replace(/热门精选/g, '热歌'));
  }

  if (/歌单|播放列表|列表/.test(intent)) {
    candidates.push(intent.replace(/歌单|播放列表|列表/g, '精选'));
  }

  return candidates;
}

function buildSceneCandidates(intent) {
  for (const entry of SCENE_SYNONYMS) {
    if (entry.pattern.test(intent)) {
      return [intent, ...entry.terms];
    }
  }
  return [];
}

function dedupe(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
