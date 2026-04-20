import { normalizeText, normalizeWhitespace } from './normalize.mjs';
import { computePlaylistPoolState, scoreHistoryPenalty } from './playback-memory.mjs';

const TERM_BUCKETS = {
  genre: { weight: 12, terms: ['民谣', '爵士', '摇滚', '电子', '钢琴', '轻音乐', '纯音乐', '古典', '流行', 'R&B', 'rb', '说唱', '嘻哈', 'hiphop', 'hip-hop', '蓝调', 'jazz', 'folk', 'rock'] },
  mood: { weight: 10, terms: ['温暖', '治愈', '轻松', '放松', '伤感', '浪漫', '欢快', '安静', '元气', '舒缓', '平静', '开心', '快乐'] },
  theme: { weight: 6, terms: ['雨天', '夜晚', '清晨', '睡前', '咖啡馆', '上午', '下午', '深夜', '晚安'] },
  scene: { weight: 4, terms: ['周末', '通勤', '做饭', '宅家', '学习', '工作', '办公', '开车', '跑步'] },
};

const NEGATIVE_PATTERNS = [
  { pattern: /别太躁|不要太躁|别躁/, token: '躁' },
  { pattern: /不要纯音乐|别纯音乐/, token: '纯音乐' },
  { pattern: /不要英文|别英文/, token: '英文' },
  { pattern: /别太吵|不要太吵/, token: '吵' },
];

const TYPE_PRIORITIES = {
  playlist: { playlist: 30, album: 10, song: 0, artist: -5 },
  artist: { artist: 30, playlist: 12, album: 6, song: 0 },
  song: { song: 30, album: 10, artist: 4, playlist: -5 },
  album: { album: 30, song: 10, artist: 4, playlist: 0 },
  generic: { playlist: 32, album: 8, song: 2, artist: -2 },
};

const CONFLICT_TERMS = {
  民谣: ['R&B', 'rb', '说唱', '嘻哈', 'hiphop', 'hip-hop', '电子'],
  爵士: ['摇滚', '电子', '说唱'],
  轻音乐: ['摇滚', '说唱'],
};

const INTENT_STOPWORDS = new Set([
  '播放',
  '想听',
  '听',
  '来点',
  '来首',
  '来一首',
  '来个',
  '来',
  '想要',
  '我要',
  '想',
  '听歌',
  '歌曲',
  '音乐',
  '歌单',
  '播放列表',
  '专辑',
  '单曲',
  '热门',
  '热歌',
  '精选',
  '的',
]);

export function rankCandidates({
  originalIntent,
  query,
  requestKind = 'generic',
  strategy = 'default',
  allowedTypes = [],
  resultGroups,
  playbackHistory = [],
  now = new Date().toISOString(),
}) {
  const tokens = classifyIntent(originalIntent || query);
  const priorityKey = resolvePriorityKey(requestKind, tokens);
  const typePriority = TYPE_PRIORITIES[priorityKey] || TYPE_PRIORITIES.generic;
  const flattened = flattenGroups(resultGroups, allowedTypes);
  const poolState = computePlaylistPoolState({ candidates: flattened, history: playbackHistory });

  if (strategy === 'playlist-first') {
    const playlistFirst = rankPlaylistFirstCandidates({
      candidates: flattened,
      playbackHistory,
      poolState,
      now,
      query,
    });
    return {
      selected: playlistFirst.selected,
      ranked: playlistFirst.ranked,
      debug: {
        tokens,
        targetTypePriority: ['playlist'],
        requestKind: priorityKey,
        allowedTypes: Array.isArray(allowedTypes) ? allowedTypes : [],
        candidateCount: flattened.length,
        playlistPool: poolState,
        playlistFirst: playlistFirst.debug,
      },
    };
  }

  const ranked = flattened
    .map((candidate) => scoreCandidate({ candidate, query, tokens, typePriority, playbackHistory, now, poolState }))
    .sort((a, b) => b.score - a.score);

  return {
    selected: ranked[0] || null,
    ranked,
    debug: {
      tokens,
      targetTypePriority: Object.entries(typePriority)
        .sort((a, b) => b[1] - a[1])
        .map(([type]) => type),
      requestKind: priorityKey,
      allowedTypes: Array.isArray(allowedTypes) ? allowedTypes : [],
      candidateCount: flattened.length,
      playlistPool: poolState,
    },
  };
}

function rankPlaylistFirstCandidates({ candidates, playbackHistory, poolState, now, query }) {
  const orderedPlaylists = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => normalizeText(candidate.type) === 'playlist')
    .map((candidate, index) => {
      const title = normalizeWhitespace(candidate.title || candidate.clickLabel || '');
      const normalizedTitle = normalizeText(title);
      const historyPenalty = scoreHistoryPenalty({
        candidate: { ...candidate, title },
        history: playbackHistory,
        now,
        query,
      });
      const playedInPool = Boolean(
        normalizedTitle &&
        Array.isArray(poolState?.playedInPool) &&
        poolState.playedInPool.some((entry) => normalizeText(entry) === normalizedTitle)
      );
      const historyScore = historyPenalty.total;
      return {
        ...candidate,
        title,
        score: historyScore - index * 0.01,
        orderIndex: index,
        eligible: !playedInPool,
        skipReason: playedInPool ? 'played-in-visible-pool' : null,
        historyScore,
        historyReasons: historyPenalty.reasons,
        playedInPool,
      };
    })
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return left.orderIndex - right.orderIndex;
    });

  const selected = orderedPlaylists.find((candidate) => candidate.eligible)
    || orderedPlaylists[0]
    || null;

  return {
    selected,
    ranked: orderedPlaylists,
    debug: {
      active: true,
      selectedTitle: selected?.title || null,
      poolExhausted: Boolean(poolState?.poolExhausted),
      considered: orderedPlaylists.map((candidate) => ({
        orderIndex: candidate.orderIndex,
        title: candidate.title,
        targetIndex: candidate.targetIndex ?? null,
        source: candidate.source || null,
        eligible: candidate.eligible,
        skipReason: candidate.skipReason,
        playedInPool: candidate.playedInPool,
        historyScore: candidate.historyScore,
        historyReasons: candidate.historyReasons,
      })),
    },
  };
}

function scoreCandidate({ candidate, query, tokens, typePriority, playbackHistory, now, poolState }) {
  const title = normalizeWhitespace(candidate.title || candidate.clickLabel || '');
  const haystack = normalizeText([title, candidate.scopeText, candidate.sectionLabel, candidate.service].filter(Boolean).join(' '));
  const breakdown = [];
  let score = typePriority[candidate.type] ?? 0;
  breakdown.push({ kind: 'type', value: typePriority[candidate.type] ?? 0 });

  for (const [bucket, bucketInfo] of Object.entries(TERM_BUCKETS)) {
    for (const token of tokens[bucket]) {
      if (haystack.includes(normalizeText(token))) {
        score += bucketInfo.weight;
        breakdown.push({ kind: bucket, token, value: bucketInfo.weight });
      }
    }
  }

  const adjacentBonus = scoreAdjacency(title, tokens.core);
  if (adjacentBonus) {
    score += adjacentBonus;
    breakdown.push({ kind: 'adjacency', value: adjacentBonus });
  }

  const queryTokens = normalizeText(query).split(' ').filter(Boolean);
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 3;
      breakdown.push({ kind: 'query', token, value: 3 });
    }
  }

  for (const token of tokens.intent) {
    const normalizedToken = normalizeText(token);
    if (!normalizedToken || normalizedToken.length < 2) continue;
    if (haystack.includes(normalizedToken)) {
      score += 6;
      breakdown.push({ kind: 'intent', token, value: 6 });
    }
  }

  const intentMatches = tokens.intent.filter((token) => haystack.includes(normalizeText(token))).length;
  if (candidate.type === 'playlist' && tokens.intent.length && intentMatches === 0) {
    score -= 18;
    breakdown.push({ kind: 'query-drift', value: -18 });
  } else if (candidate.type === 'playlist' && intentMatches > 0) {
    score += Math.min(intentMatches * 2, 8);
    breakdown.push({ kind: 'playlistTitleSemanticMatch', value: Math.min(intentMatches * 2, 8) });
  }

  const negativePenalty = scoreNegativePenalty({ haystack, negatives: tokens.negative });
  if (negativePenalty) {
    score += negativePenalty;
    breakdown.push({ kind: 'negative', value: negativePenalty });
  }

  const conflictPenalty = scoreConflictPenalty({ haystack, genres: tokens.genre });
  if (conflictPenalty) {
    score += conflictPenalty;
    breakdown.push({ kind: 'conflict', value: conflictPenalty });
  }

  const historyPenalty = scoreHistoryPenalty({ candidate: { ...candidate, title }, history: playbackHistory, now, query });
  if (historyPenalty.total) {
    score += historyPenalty.total;
    breakdown.push({ kind: 'history', value: historyPenalty.total, reasons: historyPenalty.reasons });
  }

  if (candidate.type === 'playlist' && poolState && Array.isArray(poolState.playedInPool) && !poolState.poolExhausted) {
    const normalizedTitle = normalizeText(title);
    if (poolState.playedInPool.some((entry) => normalizeText(entry) === normalizedTitle)) {
      score -= 200;
      breakdown.push({ kind: 'playlist-pool-avoid', value: -200 });
    }
  }

  return {
    ...candidate,
    title,
    score,
    breakdown,
  };
}

function classifyIntent(intent) {
  const normalized = normalizeWhitespace(intent);
  const tokens = {
    genre: [],
    mood: [],
    theme: [],
    scene: [],
    negative: [],
    core: [],
    intent: [],
  };

  for (const [bucket, bucketInfo] of Object.entries(TERM_BUCKETS)) {
    for (const term of bucketInfo.terms) {
      if (normalized.toLowerCase().includes(term.toLowerCase())) {
        tokens[bucket].push(term);
      }
    }
  }

  for (const entry of NEGATIVE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      tokens.negative.push(entry.token);
    }
  }

  tokens.core = [...tokens.genre, ...tokens.mood, ...tokens.theme, ...tokens.scene];
  tokens.intent = extractIntentTokens(normalized, tokens.core);
  return tokens;
}

function resolvePriorityKey(requestKind, tokens) {
  if (requestKind && requestKind !== 'generic') return requestKind;
  if (tokens.genre.length || tokens.mood.length || tokens.scene.length || tokens.theme.length) return 'playlist';
  return 'generic';
}

function flattenGroups(resultGroups = {}, allowedTypes = []) {
  const normalizedAllowedTypes = new Set(
    (Array.isArray(allowedTypes) ? allowedTypes : [])
      .map((type) => normalizeWhitespace(type))
      .filter(Boolean)
  );
  return Object.entries(resultGroups)
    .flatMap(([type, entries]) => (entries || []).map((entry) => ({ ...entry, type: entry.type || type })))
    .filter((entry) => !normalizedAllowedTypes.size || normalizedAllowedTypes.has(normalizeWhitespace(entry.type)))
    .filter((entry) => normalizeWhitespace(entry.title || entry.clickLabel));
}

function scoreAdjacency(title, coreTokens) {
  if (!coreTokens || coreTokens.length < 2) return 0;
  const normalized = normalizeWhitespace(title);
  for (let index = 0; index < coreTokens.length - 1; index += 1) {
    const joined = `${coreTokens[index]}${coreTokens[index + 1]}`;
    if (normalized.includes(joined)) return 5;
    const nearby = new RegExp(`${escapeRegExp(coreTokens[index])}.{0,2}${escapeRegExp(coreTokens[index + 1])}`);
    if (nearby.test(normalized)) return 5;
  }
  return 0;
}

function scoreNegativePenalty({ haystack, negatives }) {
  let penalty = 0;
  for (const token of negatives) {
    if (haystack.includes(normalizeText(token))) {
      penalty -= 12;
    }
  }
  return penalty;
}

function scoreConflictPenalty({ haystack, genres }) {
  let penalty = 0;
  for (const genre of genres) {
    const conflicts = CONFLICT_TERMS[genre] || [];
    if (conflicts.some((term) => haystack.includes(normalizeText(term)))) {
      penalty -= 8;
    }
  }
  return penalty;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractIntentTokens(intent, coreTokens = []) {
  if (!intent) return [];
  const baseParts = normalizeWhitespace(intent)
    .split(/[\s,，。！？、/|]+/)
    .filter(Boolean);

  const splitPattern = /(?:热门精选|热歌|热门|精选|歌单|播放列表|专辑|歌曲|单曲|音乐|的)/g;
  const rawTokens = baseParts.flatMap((part) => part.split(splitPattern).filter(Boolean));
  const coreSet = new Set(coreTokens.map((token) => normalizeText(token)));

  return [...new Set(rawTokens)]
    .map((token) => normalizeWhitespace(token))
    .filter((token) => token.length >= 2 && !INTENT_STOPWORDS.has(token) && !coreSet.has(normalizeText(token)));
}
