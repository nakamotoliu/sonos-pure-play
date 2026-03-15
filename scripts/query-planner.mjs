import { normalizeWhitespace } from './normalize.mjs';

const LEADING_INTENT_PREFIX = /^(请|麻烦|帮我|给我|让我|想听|我想听|我想要|我要|在[^ ]+?(播放|放|搜|搜索|找)|在[^ ]+?听|替我|帮忙)?/;
const LEADING_ACTION_PREFIX = /^(播放|放一下|放一首|放点|放|搜一下|搜索一下|搜索|搜|找一下|找|听一下|听|来一首|来点|来点儿|来首|来个|整点)/;
const TRAILING_FILLERS = /(吧|一下|一点|一些|谢谢|好吗|可以吗)$/g;
const STOP_WORD_PATTERN = /(今天|现在|想听点|想听|听点|适合|来点|来首|来一首|给我|帮我|麻烦|请|一下|一些|一点|音乐|歌曲|听歌|歌|的|了|呀|啊)/g;
const REQUEST_KIND_PATTERNS = {
  album: /(专辑|album)/i,
  song: /(单曲|歌曲|一首|这首|track|song)/i,
  artist: /(歌手|艺人|艺术家|热歌|热门|热门精选)/i,
  playlist: /(歌单|播放列表|列表|精选|合集|bgm|bmg)/i,
};
const TERM_BUCKETS = [
  { label: 'genre', terms: ['民谣', '爵士', '摇滚', '电子', '钢琴', '轻音乐', '纯音乐', '古典', '流行', 'R&B', 'rb', '说唱', '嘻哈', 'hiphop', 'hip-hop', '蓝调', 'jazz', 'folk', 'rock'] },
  { label: 'mood', terms: ['温暖', '治愈', '轻松', '放松', '伤感', '浪漫', '欢快', '安静', '元气', '舒缓', '平静', '开心', '快乐'] },
  { label: 'theme', terms: ['雨天', '夜晚', '清晨', '睡前', '咖啡馆', '上午', '下午', '深夜', '晚安'] },
  { label: 'scene', terms: ['周末', '通勤', '做饭', '宅家', '学习', '工作', '办公', '开车', '跑步'] },
];

const SCENE_SYNONYMS = [
  { pattern: /放松|chill|轻松/, terms: ['放松', '轻音乐', '治愈'] },
  { pattern: /提神|打起精神|醒脑/, terms: ['提神', '活力', '热歌'] },
  { pattern: /睡觉|睡前|助眠|入睡/, terms: ['助眠', '睡眠', '轻音乐'] },
  { pattern: /专注|学习|工作|办公/, terms: ['专注', '学习', '纯音乐'] },
];

const SHORT_QUERY_MAX_LENGTH = 6;
const SHORT_QUERY_MAX_TOKENS = 2;

export function buildQueryPlan({ request }) {
  const normalizedRequest = normalizeWhitespace(request);
  const originalIntent = cleanIntent(normalizedRequest) || normalizedRequest;
  const requestKind = inferRequestKind(originalIntent);
  const shortQuery = isShortIntent(originalIntent);
  const priorityTerms = extractPriorityTerms(originalIntent);
  const compressedQueries = dedupe([
    ...buildExactFirstCandidates(originalIntent),
    ...buildCompressedCandidates(originalIntent),
    ...buildHeuristicCandidates(originalIntent),
    ...buildSceneCandidates(originalIntent),
    ...buildTokenFallbackCandidates(originalIntent),
  ]).slice(0, 4);
  const shortRecallQueries = buildShortQueryRecallCandidates(originalIntent, requestKind);
  const orderedRecallSeed = shortQuery
    ? [...shortRecallQueries, ...compressedQueries]
    : [...compressedQueries, ...shortRecallQueries];
  const recallQueries = dedupe([
    ...orderedRecallSeed,
  ]).slice(0, 7);
  const intentProfile = {
    requestKind,
    shortQuery,
    priorityTerms,
    viewAllTokens: buildViewAllTokens({ originalIntent, requestKind, priorityTerms }),
    minCandidateScore: shortQuery ? 10 : 12,
  };

  return {
    request: normalizedRequest,
    intent: originalIntent,
    originalIntent,
    requestKind,
    shortQuery,
    compressedQueries,
    recallQueries,
    queries: recallQueries,
    intentProfile,
  };
}

function buildViewAllTokens({ originalIntent, requestKind, priorityTerms }) {
  const kindLabels = {
    playlist: ['播放列表', '歌单', '精选'],
    artist: ['艺术家', '艺人', '歌手', '热门'],
    album: ['专辑', 'album'],
    song: ['歌曲', '单曲', 'track', 'song'],
    generic: ['热门', '精选'],
  };

  return dedupe([
    originalIntent,
    ...priorityTerms,
    ...(kindLabels[requestKind] || kindLabels.generic),
  ]).filter(Boolean);
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

function buildCompressedCandidates(intent) {
  const candidates = [];
  if (!intent) return candidates;

  const parts = classifyPriorityTerms(intent);
  const primaryGenre = parts.genre[0];
  const modifiers = [...parts.mood, ...parts.scene, ...parts.theme].slice(0, 2);

  if (primaryGenre && modifiers.length) {
    candidates.push(`${modifiers[0]}${primaryGenre}`);
    if (modifiers[1]) {
      candidates.push(`${modifiers[0]}${modifiers[1]}${primaryGenre}`);
      candidates.push(`${modifiers[1]}${primaryGenre}`);
    }
  }

  const tokenCandidates = extractPriorityTerms(intent);
  if (!candidates.length && tokenCandidates.length >= 2) {
    candidates.push(tokenCandidates.slice(0, 2).join(''));
    candidates.push(tokenCandidates.slice(0, 3).join(''));
  }
  if (primaryGenre) {
    candidates.push(primaryGenre);
  } else if (tokenCandidates.length >= 1) {
    candidates.push(tokenCandidates[tokenCandidates.length - 1]);
  }

  const stripped = normalizeWhitespace(intent.replace(STOP_WORD_PATTERN, ' '));
  if (stripped && stripped !== intent) {
    candidates.push(stripped);
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

function buildTokenFallbackCandidates(intent) {
  const tokens = extractPriorityTerms(intent);
  if (tokens.length <= 1) return [];
  return [
    tokens.join(''),
    tokens.slice(0, 2).join(' '),
  ];
}

function buildShortQueryRecallCandidates(intent, requestKind) {
  if (!isShortIntent(intent)) return [];

  const normalizedIntent = normalizeWhitespace(intent);
  if (!normalizedIntent) return [];

  const compact = normalizedIntent.replace(/\s+/g, '');
  const tokens = tokenizeIntent(normalizedIntent);
  const primaryToken = tokens[0] || compact;
  const intentCore = dedupe([normalizedIntent, compact, primaryToken]).filter(Boolean);

  const kindSuffixes = {
    playlist: ['热门精选', '精选歌单', '歌单'],
    artist: ['热门精选', '热歌'],
    album: ['专辑'],
    song: ['歌曲', '单曲'],
    generic: ['热门', '精选'],
  };

  const suffixes = kindSuffixes[requestKind] || kindSuffixes.generic;
  const candidates = [...intentCore];

  for (const seed of intentCore) {
    for (const suffix of suffixes) {
      candidates.push(`${seed} ${suffix}`);
      candidates.push(`${seed}${suffix}`);
    }
  }

  return dedupe(candidates);
}

function inferRequestKind(intent) {
  for (const [kind, pattern] of Object.entries(REQUEST_KIND_PATTERNS)) {
    if (pattern.test(intent)) return kind;
  }

  const priorityTerms = extractPriorityTerms(intent);
  if (priorityTerms.some((term) => hasBucketTerm('genre', term) || hasBucketTerm('mood', term) || hasBucketTerm('scene', term) || hasBucketTerm('theme', term))) {
    return 'playlist';
  }

  return 'generic';
}

function extractPriorityTerms(intent) {
  const parts = classifyPriorityTerms(intent);
  const values = [...parts.scene, ...parts.mood, ...parts.theme, ...parts.genre];
  const compact = normalizeWhitespace(intent.replace(STOP_WORD_PATTERN, ' '));
  const spaceTokens = compact.split(' ').filter(Boolean);

  for (const token of spaceTokens) {
    if (token.length >= 2 && !values.includes(token)) {
      values.push(token);
    }
  }

  return dedupe(values).slice(0, 4);
}

function classifyPriorityTerms(intent) {
  const values = [];
  const buckets = { genre: [], mood: [], theme: [], scene: [] };
  for (const bucket of TERM_BUCKETS) {
    for (const term of bucket.terms) {
      if (intent.toLowerCase().includes(term.toLowerCase())) {
        values.push(term);
        buckets[bucket.label].push(term);
      }
    }
  }
  return {
    ...buckets,
    all: dedupe(values),
  };
}

function tokenizeIntent(intent) {
  return normalizeWhitespace(intent)
    .split(/[\s,，。！？、/|]+/)
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
}

function isShortIntent(intent) {
  const normalized = normalizeWhitespace(intent);
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, '');
  const tokens = tokenizeIntent(normalized);
  return compact.length <= SHORT_QUERY_MAX_LENGTH || tokens.length <= SHORT_QUERY_MAX_TOKENS;
}

function hasBucketTerm(label, term) {
  return TERM_BUCKETS.some((bucket) => bucket.label === label && bucket.terms.some((entry) => entry.toLowerCase() === String(term || '').toLowerCase()));
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
