import { normalizeWhitespace } from './normalize.mjs';

const LEADING_INTENT_PREFIX = /^(请|麻烦|帮我|给我|让我|想听|我想听|我想要|我要|在[^ ]+?(播放|放|搜|搜索|找)|在[^ ]+?听|替我|帮忙)?/;
const LEADING_ACTION_PREFIX = /^(播放|放一下|放一首|放点|放|搜一下|搜索一下|搜索|搜|找一下|找|听一下|听|来一首|来点|来点儿|来首|来个|整点)/;
const TRAILING_FILLERS = /(吧|一下|一点|一些|谢谢|好吗|可以吗)$/g;
const STOP_WORD_PATTERN = /(今天|现在|想听点|想听|听点|适合|来点|来首|来一首|给我|帮我|麻烦|请|一下|一些|一点|音乐|歌曲|听歌|的|了|呀|啊)/g;
const REQUEST_KIND_PATTERNS = {
  album: /(专辑|album)/i,
  song: /(单曲|歌曲|一首|这首|track|song)/i,
  artist: /(歌手|艺人|艺术家)/i,
  playlist: /(歌单|播放列表|列表|精选|合集|热歌|热门|热门精选|bgm|bmg)/i,
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

const PLAYLIST_FIRST_PATTERNS = [
  /千禧|年代|年华|经典|老歌|怀旧|风格|系|向|路线|主题|场景|适合|合集|精选|串烧|榜单/i,
  /男歌手|女歌手|某类歌手|华语男|华语女|欧美男|欧美女|歌手们|歌手合集/i,
  /民谣|爵士|摇滚|电子|钢琴|轻音乐|纯音乐|古典|流行|R&B|rb|说唱|嘻哈|hiphop|hip-hop|蓝调|jazz|folk|rock/i,
];
const BROAD_THEMATIC_PLAYLIST_PATTERNS = [
  /日漫|动漫|二次元|acg|anime/i,
  /燃曲|神曲|热血|战歌|泪目|名场面/i,
  /bgm|ost|主题曲|片头曲|片尾曲|插曲/i,
];

const SHORT_QUERY_MAX_LENGTH = 6;
const SHORT_QUERY_MAX_TOKENS = 2;
const HARD_QUERY_MAX_COMPACT_LENGTH = 6;
const HARD_QUERY_MAX_TOKEN_COUNT = 4;
const HARD_QUERY_MAX_SEMANTIC_TERMS = 3;
const PLAYLIST_FIRST_QUERY_MAX_COMPACT_LENGTH = 8;
const CJK_PATTERN = /[\u3400-\u9fff]/;
const SEMANTIC_QUERY_PATTERNS = [
  { pattern: /千禧年?|y2k/ig, term: '千禧' },
  { pattern: /80后|八零/ig, term: '80后' },
  { pattern: /90后|九零/ig, term: '90后' },
  { pattern: /00后|零零后/ig, term: '00后' },
  { pattern: /华语|国语/ig, term: '华语' },
  { pattern: /粤语/ig, term: '粤语' },
  { pattern: /欧美/ig, term: '欧美' },
  { pattern: /日韩/ig, term: '日韩' },
  { pattern: /男歌手|男艺人|男歌者|男声/ig, term: '男声' },
  { pattern: /女歌手|女艺人|女歌者|女声/ig, term: '女声' },
];

export function buildQueryPlan({ request }) {
  const normalizedRequest = normalizeWhitespace(request);
  const originalIntent = cleanIntent(normalizedRequest) || normalizedRequest;
  const requestKind = inferRequestKind(originalIntent);
  const strategy = inferExecutionStrategy({ originalIntent, requestKind });
  const allowedTypes = resolveAllowedTypes(strategy);
  const shortQuery = isShortIntent(originalIntent);
  const priorityTerms = extractPriorityTerms(originalIntent);
  const queryMode = 'shrink-by-char';
  const queries = buildShrinkingQueries(originalIntent);
  const intentProfile = {
    requestKind,
    strategy,
    allowedTypes,
    shortQuery,
    priorityTerms,
    viewAllTokens: buildViewAllTokens({ originalIntent, requestKind, priorityTerms }),
    minCandidateScore: shortQuery ? 10 : 12,
    maxCandidateAttemptsPerQuery: strategy === 'playlist-first' ? 2 : 1,
  };
  const flowHints = {
    preferredSection: strategy === 'playlist-first' ? 'playlist' : null,
    preferredResultsView: strategy === 'playlist-first' ? 'PLAYLISTS' : null,
    preferredDetailType: strategy === 'playlist-first' ? 'playlist' : null,
    maxCandidateAttemptsPerQuery: intentProfile.maxCandidateAttemptsPerQuery,
  };

  return {
    request: normalizedRequest,
    intent: originalIntent,
    originalIntent,
    requestKind,
    strategy,
    allowedTypes,
    shortQuery,
    queryMode,
    compressedQueries: queries,
    recallQueries: queries,
    queries,
    intentProfile,
    flowHints,
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

function buildShrinkingQueries(intent) {
  const normalized = normalizeWhitespace(intent || '');
  if (!normalized) return [];

  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return [];

  const queries = [];
  for (let length = compact.length; length >= 2; length -= 1) {
    const candidate = compact.slice(0, length);
    if (isSaneShrinkingQuery(candidate)) {
      queries.push(candidate);
    }
  }

  if (!queries.length && compact.length >= 2) {
    queries.push(compact.slice(0, Math.max(2, compact.length)));
  }

  return dedupe(queries);
}

function isSaneShrinkingQuery(value) {
  const normalized = normalizeWhitespace(value || '');
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/g, '');
  if (compact.length < 2) return false;

  const asciiTokens = compact.split(/\s+/).filter(Boolean);
  if (asciiTokens.some((token) => /^[A-Za-z]$/.test(token))) return false;

  if (/^[A-Za-z0-9&+\-]{1}$/i.test(compact)) return false;
  if (/[&+\-]$/.test(compact)) return false;
  if (/^[A-Za-z&+\-]{2}$/i.test(compact)) return false;

  return true;
}

// Legacy planner helpers kept temporarily for reference while shrink-by-char is the active query mode.
// They are no longer used by buildQueryPlan and should be removed after the new flow is validated.
function buildExactFirstCandidates(intent) {
  const candidates = [];
  if (!intent) return candidates;

  if (canUseOriginalIntentAsQuery(intent)) {
    candidates.push(intent);
  }

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
  const semanticTerms = extractSemanticQueryTerms(intent);
  const primaryGenre = parts.genre[0];
  const modifiers = [...parts.mood, ...parts.scene, ...parts.theme].slice(0, 2);

  if (semanticTerms.length >= 2) {
    candidates.push(semanticTerms.slice(0, 2).join(''));
    if (semanticTerms.length >= 3) {
      candidates.push(semanticTerms.slice(1, 3).join(''));
      candidates.push(`${semanticTerms[0]}${semanticTerms[2]}`);
    }
  }

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
      return canUseOriginalIntentAsQuery(intent) ? [intent, ...entry.terms] : [...entry.terms];
    }
  }
  return [];
}

function buildTokenFallbackCandidates(intent) {
  const semanticTerms = extractSemanticQueryTerms(intent);
  if (semanticTerms.length >= 2) {
    const candidates = [
      semanticTerms.slice(0, 2).join(''),
    ];
    if (semanticTerms.length >= 3) {
      candidates.push(semanticTerms.slice(0, 3).join(''));
      candidates.push(semanticTerms.slice(1, 3).join(''));
    }
    return candidates;
  }

  const tokens = extractPriorityTerms(intent).filter((token) => canUseTokenFallback(token));
  if (tokens.length <= 1) return [];
  return [
    tokens.join(''),
    tokens.slice(0, 2).join(' '),
  ];
}

function buildShortQueryRecallCandidates(intent, requestKind, strategy = 'default') {
  if (strategy === 'playlist-first') return [];
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

function inferExecutionStrategy({ originalIntent, requestKind }) {
  const normalizedIntent = normalizeWhitespace(originalIntent);
  if (!normalizedIntent) return 'default';
  if (requestKind === 'album' || requestKind === 'song') return 'default';
  if (requestKind === 'playlist') return 'playlist-first';
  if (isBroadThematicPlaylistRequest(normalizedIntent)) return 'playlist-first';
  if (PLAYLIST_FIRST_PATTERNS.some((pattern) => pattern.test(normalizedIntent))) return 'playlist-first';
  if (extractPriorityTerms(normalizedIntent).length >= 2 && !isLikelyLiteralEntityIntent(normalizedIntent)) return 'playlist-first';
  return 'default';
}

function isBroadThematicPlaylistRequest(intent) {
  const normalizedIntent = normalizeWhitespace(intent);
  if (!normalizedIntent) return false;

  const matchesBroadTheme = BROAD_THEMATIC_PLAYLIST_PATTERNS.some((pattern) => pattern.test(normalizedIntent));
  if (!matchesBroadTheme) return false;

  const compact = normalizedIntent.replace(/\s+/g, '');
  return compact.length <= 8 || tokenizeIntent(normalizedIntent).length <= 2;
}

function isLikelyLiteralEntityIntent(intent) {
  const normalized = normalizeWhitespace(intent);
  if (!normalized) return false;
  if (!CJK_PATTERN.test(normalized)) return false;
  if (PLAYLIST_FIRST_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (BROAD_THEMATIC_PLAYLIST_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (REQUEST_KIND_PATTERNS.playlist.test(normalized)) return false;

  const tokens = tokenizeIntent(normalized);
  if (tokens.length !== 1) return false;

  const semanticTerms = extractSemanticQueryTerms(normalized);
  if (semanticTerms.length > 0) return false;

  return normalized.replace(/\s+/g, '').length >= 3;
}

function resolveAllowedTypes(strategy) {
  if (strategy === 'playlist-first') return ['playlist'];
  return [];
}

function extractPriorityTerms(intent) {
  const parts = classifyPriorityTerms(intent);
  const semanticTerms = extractSemanticQueryTerms(intent);
  const values = [...semanticTerms, ...parts.scene, ...parts.mood, ...parts.theme, ...parts.genre];
  const compact = normalizeWhitespace(intent.replace(STOP_WORD_PATTERN, ' '));
  const spaceTokens = compact.split(' ').filter(Boolean);

  for (const token of spaceTokens) {
    if (semanticTerms.length >= 2 && CJK_PATTERN.test(token) && !token.includes(' ')) {
      continue;
    }
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

function extractSemanticQueryTerms(intent) {
  const terms = [];
  for (const entry of SEMANTIC_QUERY_PATTERNS) {
    if (entry.pattern.test(intent)) {
      terms.push(entry.term);
    }
    entry.pattern.lastIndex = 0;
  }

  const parts = classifyPriorityTerms(intent);
  return dedupe([
    ...terms,
    ...parts.scene,
    ...parts.mood,
    ...parts.theme,
    ...parts.genre,
  ]).slice(0, HARD_QUERY_MAX_SEMANTIC_TERMS);
}

function isShortIntent(intent) {
  const normalized = normalizeWhitespace(intent);
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, '');
  const tokens = tokenizeIntent(normalized);
  if (compact.length <= SHORT_QUERY_MAX_LENGTH) return true;
  if (tokens.length > SHORT_QUERY_MAX_TOKENS) return false;
  if (tokens.length === 1 && CJK_PATTERN.test(tokens[0])) return false;
  return true;
}

function canUseOriginalIntentAsQuery(intent) {
  return isAllowedSearchQuery(intent, { originalIntent: intent, allowLongOriginalIntent: false });
}

function canUseTokenFallback(token) {
  const normalized = normalizeWhitespace(token);
  if (!normalized) return false;
  if (!CJK_PATTERN.test(normalized)) return true;
  return normalized.length <= HARD_QUERY_MAX_COMPACT_LENGTH;
}

function sanitizeSearchQueries(values, { originalIntent, strategy = 'default', requestKind = 'generic', allowLongOriginalIntent = false } = {}) {
  return dedupe(values).filter((value) => isAllowedSearchQuery(value, { originalIntent, strategy, requestKind, allowLongOriginalIntent }));
}

function isAllowedSearchQuery(query, { originalIntent, strategy = 'default', requestKind = 'generic', allowLongOriginalIntent = false } = {}) {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return false;

  const normalizedOriginalIntent = normalizeWhitespace(originalIntent || '');
  if (!allowLongOriginalIntent && normalized === normalizedOriginalIntent && !isShortIntent(normalizedOriginalIntent)) {
    return false;
  }

  if (isShortIntent(normalized)) {
    return isStrategyAllowedSearchQuery(normalized, { originalIntent, strategy, requestKind });
  }

  const compact = normalized.replace(/\s+/g, '');
  const tokens = tokenizeIntent(normalized);

  if (CJK_PATTERN.test(normalized) && tokens.length <= 1) {
    const semanticTerms = extractSemanticQueryTerms(normalized);
    const allowed = semanticTerms.length >= 2
      && semanticTerms.length <= HARD_QUERY_MAX_SEMANTIC_TERMS
      && compact.length <= HARD_QUERY_MAX_COMPACT_LENGTH;
    return allowed && isStrategyAllowedSearchQuery(normalized, { originalIntent, strategy, requestKind });
  }

  const allowed = tokens.length <= HARD_QUERY_MAX_TOKEN_COUNT;
  return allowed && isStrategyAllowedSearchQuery(normalized, { originalIntent, strategy, requestKind });
}

function isStrategyAllowedSearchQuery(query, { originalIntent, strategy, requestKind }) {
  if (strategy !== 'playlist-first') return true;
  return isPlaylistFirstSearchQuery(query, { originalIntent, requestKind });
}

function isPlaylistFirstSearchQuery(query, { originalIntent, requestKind }) {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return false;

  const normalizedOriginalIntent = normalizeWhitespace(originalIntent || '');
  const compact = normalized.replace(/\s+/g, '');
  const semanticTerms = extractSemanticQueryTerms(normalized);
  const priorityTerms = extractPriorityTerms(normalized);
  const tokens = tokenizeIntent(normalized);
  const termCount = semanticTerms.length || priorityTerms.length || tokens.length;

  if (compact.length > PLAYLIST_FIRST_QUERY_MAX_COMPACT_LENGTH) {
    return false;
  }

  if (termCount < 1 || termCount > HARD_QUERY_MAX_TOKEN_COUNT) {
    return false;
  }

  if (normalized === normalizedOriginalIntent) {
    const originalTermCount = extractSemanticQueryTerms(normalizedOriginalIntent).length
      || extractPriorityTerms(normalizedOriginalIntent).length
      || tokenizeIntent(normalizedOriginalIntent).length;
    if (originalTermCount >= 2) {
      return false;
    }
  }

  if (requestKind === 'playlist' || PLAYLIST_FIRST_PATTERNS.some((pattern) => pattern.test(normalizedOriginalIntent))) {
    if (semanticTerms.length === 0 && priorityTerms.length === 0) {
      return tokens.length >= 1 && tokens.length <= 2;
    }
  }

  return true;
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
