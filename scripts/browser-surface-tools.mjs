import { rankCandidates } from './candidate-ranker.mjs';
import { extractUsablePageBlocksFromAriaSnapshot, shouldUseAriaSnapshotFallback } from './aria-snapshot-tools.mjs';
import { loadPlaybackHistory, scoreHistoryPenalty } from './playback-memory.mjs';
import { normalizeText, normalizeWhitespace } from './normalize.mjs';

const TYPE_PATTERNS = {
  playlist: /(播放列表|歌单|playlist|精选|合集|热歌|热门精选)/i,
  album: /(专辑|album)/i,
  artist: /(艺术家|艺人|歌手|artist)/i,
  song: /(歌曲|单曲|track|song)/i,
};

function inferCandidateType(candidate = {}) {
  const haystack = normalizeWhitespace([
    candidate.title,
    candidate.playLabel,
    candidate.scopeText,
    candidate.sectionLabel,
  ].filter(Boolean).join(' '));
  for (const [type, pattern] of Object.entries(TYPE_PATTERNS)) {
    if (pattern.test(haystack)) return type;
  }
  return 'playlist';
}

function buildResultGroups(candidates = []) {
  const groups = { playlist: [], album: [], artist: [], song: [] };
  for (const candidate of candidates) {
    const type = inferCandidateType(candidate);
    groups[type].push({ ...candidate, type });
  }
  return groups;
}

function buildRecommendationReason(entry, selected, strategy) {
  if (!selected) return 'not-selected';
  const sameCandidate = normalizeText(selected.title) === normalizeText(entry.title)
    && normalizeText(selected.type) === normalizeText(entry.type);
  if (!sameCandidate) {
    return entry.alreadySelectedBefore ? 'played-before' : 'lower-score';
  }
  if (selected.fallbackPlayableCandidate) return 'fallback-playable-candidate';
  if (strategy === 'playlist-first' && !entry.alreadySelectedBefore && entry.type === 'playlist') {
    return 'fresh-playlist';
  }
  if (strategy === 'playlist-first' && entry.type === 'playlist') {
    return 'playlist-score-fallback';
  }
  return 'top-score';
}

function resolveScoreKind(strategy) {
  if (strategy === 'playlist-first') return 'history-aware-ordering';
  return 'intent-ranking';
}

function buildSelectionSummary(candidates = [], ranking = {}, strategy = 'default', requestKind = 'generic') {
  const ordered = Array.isArray(candidates) ? candidates : [];
  const topRecommended = ordered.find((candidate) => candidate.recommended) || null;
  const topScored = ordered[0] || null;
  const scoreKind = resolveScoreKind(strategy);
  return {
    strategy,
    requestKind,
    scoreKind,
    topRecommended: topRecommended ? {
      title: topRecommended.title,
      type: topRecommended.type,
      finalScore: topRecommended.finalScore,
      scoreKind: topRecommended.scoreKind || scoreKind,
      recommendedReason: topRecommended.recommendedReason,
      alreadySelectedBefore: topRecommended.alreadySelectedBefore,
    } : null,
    topScored: topScored ? {
      title: topScored.title,
      type: topScored.type,
      finalScore: topScored.finalScore,
      scoreKind: topScored.scoreKind || scoreKind,
      recommended: Boolean(topScored.recommended),
      recommendedReason: topScored.recommendedReason,
      alreadySelectedBefore: topScored.alreadySelectedBefore,
    } : null,
    selectedByRanker: ranking?.selected ? {
      title: ranking.selected.title || null,
      type: ranking.selected.type || null,
      finalScore: ranking.selected.score ?? null,
      scoreKind,
    } : null,
  };
}

export function buildSelectionDecisionReport({
  usableBlocks = {},
  chosenTitle = '',
  chosenType = '',
  decisionReason = '',
} = {}) {
  const summary = usableBlocks?.selectionSummary || {};
  const candidates = Array.isArray(usableBlocks?.candidates) ? usableBlocks.candidates : [];
  const normalizedChosenTitle = normalizeText(chosenTitle);
  const normalizedChosenType = normalizeText(chosenType);
  const chosen = candidates.find((candidate) => (
    normalizeText(candidate.title) === normalizedChosenTitle &&
    (!normalizedChosenType || normalizeText(candidate.type) === normalizedChosenType)
  )) || null;
  const topRecommended = summary?.topRecommended || null;
  const deviation = Boolean(
    topRecommended &&
    chosen &&
    (
      normalizeText(topRecommended.title) !== normalizeText(chosen.title) ||
      normalizeText(topRecommended.type) !== normalizeText(chosen.type)
    )
  );

  return {
    topRecommended: topRecommended ? {
      title: topRecommended.title,
      type: topRecommended.type,
      finalScore: topRecommended.finalScore,
      scoreKind: topRecommended.scoreKind,
      recommendedReason: topRecommended.recommendedReason,
    } : null,
    chosen: chosen ? {
      title: chosen.title,
      type: chosen.type,
      finalScore: chosen.finalScore,
      scoreKind: chosen.scoreKind,
      recommended: Boolean(chosen.recommended),
      recommendedReason: chosen.recommendedReason,
    } : null,
    deviation,
    decisionReason: normalizeWhitespace(decisionReason),
  };
}

export function enrichUsablePageBlocks({
  usableBlocks = {},
  originalIntent = '',
  query = '',
  requestKind = 'generic',
  strategy = 'default',
  allowedTypes = [],
  playbackHistory,
  now = new Date().toISOString(),
} = {}) {
  const history = Array.isArray(playbackHistory) ? playbackHistory : loadPlaybackHistory();
  const rawCandidates = Array.isArray(usableBlocks.candidates) ? usableBlocks.candidates : [];
  const typedCandidates = rawCandidates.map((candidate) => ({
    ...candidate,
    type: inferCandidateType(candidate),
  }));
  const ranking = rankCandidates({
    originalIntent: originalIntent || query,
    query: query || originalIntent,
    requestKind,
    strategy,
    allowedTypes,
    resultGroups: buildResultGroups(typedCandidates),
    playbackHistory: history,
    now,
  });

  const rankIndex = new Map();
  ranking.ranked.forEach((entry, index) => {
    rankIndex.set(`${normalizeText(entry.title)}::${normalizeText(entry.type)}`, { ...entry, rank: index + 1 });
  });
  const scoreKind = resolveScoreKind(strategy);

  const enrichedCandidates = typedCandidates.map((candidate, index) => {
    const key = `${normalizeText(candidate.title)}::${normalizeText(candidate.type)}`;
    const ranked = rankIndex.get(key) || null;
    const historyPenalty = scoreHistoryPenalty({
      candidate: { ...candidate, type: candidate.type },
      history,
      now,
      query: query || originalIntent,
    });
    const alreadySelectedBefore = historyPenalty.reasons.some((reason) => reason.startsWith('same-title-within'));
    const baseScore = ranked ? ranked.score - historyPenalty.total : 0;
    const finalScore = ranked?.score ?? historyPenalty.total;
    const selectedSameCandidate = Boolean(
      ranked &&
      normalizeText(ranked.title) === normalizeText(ranking.selected?.title || '') &&
      normalizeText(ranked.type) === normalizeText(ranking.selected?.type || '')
    );
    const enrichedCandidate = {
      ...candidate,
      kind: 'candidate',
      type: candidate.type,
      service: candidate.service || null,
      alreadySelectedBefore,
      historyPenalty: historyPenalty.total,
      historyReasons: historyPenalty.reasons,
      baseScore,
      finalScore,
      scoreKind,
      rank: ranked?.rank || index + 1,
      queryMatchCount: ranked?.queryMatchCount || 0,
      intentMatchCount: ranked?.intentMatchCount || 0,
      semanticMatchCount: ranked?.semanticMatchCount || 0,
      fallbackPlayableCandidate: Boolean(selectedSameCandidate && ranking.selected?.fallbackPlayableCandidate),
      recommended: selectedSameCandidate,
    };
    return {
      ...enrichedCandidate,
      recommendedReason: buildRecommendationReason(enrichedCandidate, ranking.selected, strategy),
    };
  }).sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
    return (left.rank || 0) - (right.rank || 0);
  });

  return {
    ...usableBlocks,
    candidates: enrichedCandidates,
    candidateRanking: {
      strategy,
      requestKind,
      selectedTitle: ranking.selected?.title || null,
      selectedType: ranking.selected?.type || null,
      totalCandidates: enrichedCandidates.length,
    },
    selectionSummary: buildSelectionSummary(enrichedCandidates, ranking, strategy, requestKind),
  };
}

export function extractUsablePageBlocks(runner, targetId, options = {}) {
  let raw;
  try {
    const result = runner.evaluate(
      targetId,
      `() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const main = document.querySelector('main') || document.body;
      const searchInputs = [...document.querySelectorAll('input,textarea,[role="combobox"],[role="searchbox"]')]
        .filter(visible)
        .map((el) => ({
          kind: 'input',
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          placeholder: el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          value: normalize('value' in el ? el.value : el.textContent || ''),
        }))
        .slice(0, 10);
      const collectScopeText = (el, selfText = '') => {
        const texts = [];
        let current = el;
        for (let depth = 0; current && depth < 6; depth += 1) {
          const text = normalize(current.textContent || '');
          if (text && !texts.includes(text)) texts.push(text);
          current = current.parentElement;
        }
        const normalizedSelf = normalize(selfText);
        const contextual = texts.find((text) => (
          text &&
          text !== normalizedSelf &&
          text.includes(normalizedSelf) &&
          /(专辑|播放列表|歌单|playlist|艺人|歌手|artist|歌曲|单曲|album|QQ音乐|网易云音乐|Sonos Radio)/i.test(text)
        ));
        if (contextual) return contextual.slice(0, 220);
        const wider = texts.find((text) => text && text !== normalizedSelf && text.includes(normalizedSelf) && text.length > normalizedSelf.length);
        if (wider) return wider.slice(0, 220);
        const longest = texts
          .filter((text) => text && text.length <= 220)
          .sort((a, b) => b.length - a.length)[0];
        return longest || texts[0] || '';
      };
      const excludedClickableTexts = new Set([
        '清除', '查看所有', '全部', 'Sonos Radio', 'QQ音乐', '网易云音乐', '关闭',
        '返回', '前进', '首页', 'Settings', 'Close', '输出选择器', '静音', '展开',
      ]);
      const clickable = [...main.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          return ({
            kind: 'clickable',
            text,
            scopeText: collectScopeText(el, text),
            tag: el.tagName || '',
            role: el.getAttribute('role') || '',
            canClick: true,
          });
        })
        .filter((entry) => entry.text)
        .slice(0, 120);
      const explicitPlayCandidates = clickable
        .filter((entry) => /^播放/.test(entry.text))
        .map((entry) => ({
          kind: 'candidate',
          title: normalize(entry.text.replace(/^播放/, '')),
          playLabel: entry.text,
          scopeText: entry.scopeText,
          canClick: true,
        }));
      const inferredCandidates = clickable
        .filter((entry) => {
          if (!entry.text) return false;
          if (excludedClickableTexts.has(entry.text)) return false;
          if (/^(将.+设置为有效|播放群组.+)$/.test(entry.text)) return false;
          if (/^播放/.test(entry.text)) return false;
          if (entry.text.length > 40) return false;
          return /(专辑|播放列表|歌单|playlist|艺人|歌手|artist|歌曲|单曲|album)/i.test(entry.scopeText || '');
        })
        .map((entry) => ({
          kind: 'candidate',
          title: entry.text,
          playLabel: entry.text,
          scopeText: entry.scopeText,
          canClick: true,
        }));
      const seenCandidateKey = new Set();
      const candidates = [...explicitPlayCandidates, ...inferredCandidates]
        .filter((entry) => {
          const key = String(entry.title || '') + '::' + String(entry.playLabel || '');
          if (!entry.title || seenCandidateKey.has(key)) return false;
          seenCandidateKey.add(key);
          return true;
        })
        .slice(0, 40);
      const serviceTabs = clickable
        .filter((entry) => ['全部', 'QQ音乐', '网易云音乐', 'Sonos Radio'].includes(entry.text))
        .slice(0, 10);
      const menuActions = clickable
        .filter((entry) => /更多选项|替换当前歌单|替换播放列表|替换队列|立即播放|添加到队列末尾/.test(entry.text))
        .slice(0, 20);
      const rows = [...main.querySelectorAll('table tr,[role="row"]')]
        .filter(visible)
        .map((row) => normalize(row.textContent || ''))
        .filter(Boolean)
        .slice(0, 20);
      return {
        url: location.href,
        title: document.title || '',
        bodyPreview: normalize(main.innerText || '').slice(0, 1200),
        usableBlocks: {
          inputs: searchInputs,
          serviceTabs,
          candidates,
          clickables: clickable,
          menuActions,
          rows,
        },
      };
    }`
    );
    raw = result?.result || result || null;
  } catch (error) {
    if (!shouldUseAriaSnapshotFallback(error)) throw error;
    raw = extractUsablePageBlocksFromAriaSnapshot(runner.snapshot(targetId, 220));
  }
  const safeRaw = raw || { usableBlocks: { inputs: [], serviceTabs: [], candidates: [], clickables: [], menuActions: [], rows: [] } };
  return {
    ...safeRaw,
    usableBlocks: enrichUsablePageBlocks({
      usableBlocks: safeRaw.usableBlocks || {},
      originalIntent: options.originalIntent || '',
      query: options.query || '',
      requestKind: options.requestKind || 'generic',
      strategy: options.strategy || 'default',
      allowedTypes: options.allowedTypes || [],
      playbackHistory: options.playbackHistory,
      now: options.now,
    }),
  };
}
