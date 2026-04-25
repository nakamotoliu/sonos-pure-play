import { normalizeText, normalizeWhitespace } from './normalize.mjs';

const EXCLUDED_SECTION_PATTERN = /搜索记录|您的服务|系统视图/i;
const TYPE_PATTERNS = {
  playlist: /(播放列表|歌单|playlist|精选|合集|热歌|热门精选)/i,
  album: /(专辑|album)/i,
  artist: /(艺术家|艺人|歌手|artist)/i,
  song: /(歌曲|单曲|track|song)/i,
};

function normalizedNodeName(node) {
  return normalizeWhitespace(node?.name || node?.description || '');
}

function listNodes(snapshotOrNodes = []) {
  if (Array.isArray(snapshotOrNodes)) return snapshotOrNodes;
  if (Array.isArray(snapshotOrNodes?.nodes)) return snapshotOrNodes.nodes;
  return [];
}

function getSectionHeading(nodes, index) {
  const currentDepth = Number(nodes[index]?.depth ?? 0);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = nodes[cursor];
    if (Number(candidate?.depth ?? 0) >= currentDepth) continue;
    if (String(candidate?.role || '').toLowerCase() !== 'heading') continue;
    const name = normalizedNodeName(candidate);
    if (name) return name;
  }
  return '';
}

function collectDescendantNames(nodes, index, limit = 6) {
  const currentDepth = Number(nodes[index]?.depth ?? 0);
  const names = [];
  for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
    const node = nodes[cursor];
    if (Number(node?.depth ?? 0) <= currentDepth) break;
    const name = normalizedNodeName(node);
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function countMatches(values, pattern) {
  return values.reduce((sum, value) => sum + ((String(value || '').match(pattern) || []).length), 0);
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

export function shouldUseAriaSnapshotFallback(error) {
  const code = String(error?.code || '');
  const message = normalizeText(error?.message || '');
  const dataMessage = normalizeText(error?.data?.message || '');
  const haystack = `${message} ${dataMessage}`;
  return (
    code === 'BROWSER_ATTACH_FAILED' ||
    haystack.includes('playwright is not available in this gateway build') ||
    haystack.includes('act:evaluate') ||
    haystack.includes('unsupported')
  );
}

export function analyzeAriaSnapshot(snapshotOrNodes = [], options = {}) {
  const nodes = listNodes(snapshotOrNodes);
  const expectedQuery = normalizeWhitespace(options?.expectedQuery || options?.query || '');
  const url = String(snapshotOrNodes?.url || '');

  const entries = nodes.map((node, index) => {
    const role = String(node?.role || '');
    const name = normalizedNodeName(node);
    const sectionLabel = getSectionHeading(nodes, index);
    const descendantNames = collectDescendantNames(nodes, index);
    const scopeText = normalizeWhitespace([sectionLabel, ...descendantNames].join(' '));
    const interactive = ['button', 'link', 'menuitem'].includes(role.toLowerCase());
    return {
      ref: node?.ref || '',
      role,
      name,
      depth: Number(node?.depth ?? 0),
      sectionLabel,
      descendantNames,
      scopeText,
      interactive,
      inExcludedSection: EXCLUDED_SECTION_PATTERN.test(sectionLabel),
    };
  });

  const names = entries.map((entry) => entry.name).filter(Boolean);
  const nonExcludedNames = entries.filter((entry) => !entry.inExcludedSection).map((entry) => entry.name).filter(Boolean);
  const clickables = entries
    .filter((entry) => entry.interactive && entry.name)
    .map((entry) => ({
      kind: 'clickable',
      ref: entry.ref,
      text: entry.name,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      role: entry.role,
      canClick: true,
    }));
  const nonExcludedClickables = clickables.filter((entry) => !EXCLUDED_SECTION_PATTERN.test(entry.sectionLabel || ''));

  const serviceTabs = clickables
    .filter((entry) => ['全部', 'QQ音乐', '网易云音乐', 'Sonos Radio'].includes(entry.text))
    .sort((left, right) => left.text.localeCompare(right.text, 'zh-Hans-CN'))
    .slice(0, 10);
  const menuActions = nonExcludedClickables
    .filter((entry) => /更多选项|替换当前歌单|替换播放列表|替换队列|立即播放|添加到队列末尾/.test(entry.text))
    .slice(0, 20);

  const excludedClickableTexts = new Set([
    '清除', '查看所有', '全部', 'Sonos Radio', 'QQ音乐', '网易云音乐', '关闭',
    '返回', '前进', '首页', 'Settings', 'Close', '输出选择器', '静音', '展开',
  ]);
  const explicitPlayCandidates = nonExcludedClickables
    .filter((entry) => /^播放/.test(entry.text))
    .map((entry) => ({
      kind: 'candidate',
      ref: entry.ref,
      title: normalizeWhitespace(entry.text.replace(/^播放/, '')),
      playLabel: entry.text,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      canClick: true,
    }));
  const inferredCandidates = nonExcludedClickables
    .filter((entry) => {
      if (!entry.text || excludedClickableTexts.has(entry.text)) return false;
      if (/^(将.+设置为有效|播放群组.+|暂停群组.+)$/.test(entry.text)) return false;
      if (/^播放/.test(entry.text)) return false;
      if (entry.text.length > 40) return false;
      return /(专辑|播放列表|歌单|playlist|艺人|歌手|artist|歌曲|单曲|album)/i.test(entry.scopeText || '');
    })
    .map((entry) => ({
      kind: 'candidate',
      ref: entry.ref,
      title: entry.text,
      playLabel: entry.text,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      canClick: true,
    }));
  const candidatePool = [...explicitPlayCandidates, ...inferredCandidates];
  const candidates = unique(candidatePool.map((entry) => `${entry.title}::${entry.playLabel}`))
    .map((key) => candidatePool.find((entry) => `${entry.title}::${entry.playLabel}` === key))
    .filter(Boolean)
    .slice(0, 40);

  const searchInputs = entries
    .filter((entry) => ['combobox', 'searchbox', 'textbox'].includes(entry.role.toLowerCase()))
    .map((entry) => ({
      kind: 'input',
      ref: entry.ref,
      role: entry.role,
      aria: entry.name,
      placeholder: '',
      value: '',
    }))
    .slice(0, 10);

  const rawSearchHistoryVisible = names.includes('搜索记录');
  const queryVisibleSomewhere = Boolean(expectedQuery) && names.some((name) => name.includes(expectedQuery));
  const visibleQueryInInput = Boolean(expectedQuery) && searchInputs.some((entry) => normalizeWhitespace(entry.value).includes(expectedQuery));
  const typeLabelCounts = {
    playlist: countMatches(nonExcludedNames, TYPE_PATTERNS.playlist),
    album: countMatches(nonExcludedNames, TYPE_PATTERNS.album),
    artist: countMatches(nonExcludedNames, TYPE_PATTERNS.artist),
    song: countMatches(nonExcludedNames, TYPE_PATTERNS.song),
  };
  const typeLabelSignalCount = Object.values(typeLabelCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const viewAllCount = nonExcludedClickables.filter((entry) => /查看全部|查看所有|查看更多|展开/.test(entry.text)).length;
  const playableButtonCount = nonExcludedClickables.filter((entry) => /^播放/.test(entry.text)).length;
  const serviceLabels = unique(nonExcludedNames.filter((name) => /网易云音乐|QQ音乐|Sonos Radio/.test(name)));
  const serviceSectionCount = serviceLabels.length;
  const structuralCardCount = candidates.length + viewAllCount;
  const candidateCount = candidates.length;
  const realtimeResultStructure = Boolean(
    candidateCount >= 2 ||
    (viewAllCount > 0 && (candidateCount > 0 || typeLabelSignalCount > 0 || queryVisibleSomewhere)) ||
    (playableButtonCount > 0 && (candidateCount > 0 || typeLabelSignalCount > 0 || queryVisibleSomewhere))
  );
  const resultsPresentReasons = [
    visibleQueryInInput && candidateCount >= 2 ? 'query-visible-plus-multiple-result-cards' : null,
    visibleQueryInInput && viewAllCount > 0 ? 'query-visible-plus-view-all-controls' : null,
    visibleQueryInInput && playableButtonCount > 0 ? 'query-visible-plus-playable-buttons' : null,
    candidateCount >= 2 && typeLabelSignalCount > 0 ? 'multiple-result-cards-plus-type-labels' : null,
    candidateCount >= 2 && playableButtonCount > 0 ? 'multiple-result-cards-plus-playable-buttons' : null,
    viewAllCount > 0 && typeLabelSignalCount > 0 ? 'view-all-controls-plus-type-labels' : null,
    viewAllCount > 0 && playableButtonCount > 0 ? 'view-all-controls-plus-playable-buttons' : null,
  ].filter(Boolean);
  const searchPageReady = Boolean(url.includes('/search') && searchInputs.length);
  const staleHistoryWithoutQuery = Boolean(expectedQuery && !queryVisibleSomewhere && rawSearchHistoryVisible);
  const historyVisible = Boolean(rawSearchHistoryVisible && !realtimeResultStructure);
  const resultsFreshForExpectedQuery = Boolean(
    url.includes('/search') &&
    realtimeResultStructure &&
    (visibleQueryInInput || queryVisibleSomewhere) &&
    resultsPresentReasons.length > 0 &&
    !staleHistoryWithoutQuery
  );
  const resultsPresent = Boolean(
    url.includes('/search') &&
    realtimeResultStructure &&
    resultsPresentReasons.length > 0 &&
    !staleHistoryWithoutQuery
  );
  const playlistOnly = Boolean(
    resultsPresent &&
    typeLabelCounts.playlist > 0 &&
    typeLabelCounts.album === 0 &&
    typeLabelCounts.artist === 0 &&
    typeLabelCounts.song === 0
  );
  const pageKind =
    resultsPresent && playlistOnly ? 'SEARCH_RESULTS_PLAYLISTS' :
    resultsPresent ? 'SEARCH_RESULTS_MIXED' :
    historyVisible ? 'SEARCH_HISTORY' :
    url.includes('/search') ? 'SEARCH_READY' :
    url.includes('/web-app') ? 'APP_HOME' :
    'UNKNOWN';

  return {
    pageState: {
      pageKind,
      url,
      title: normalizeWhitespace(snapshotOrNodes?.title || names[0] || ''),
      onSearchPage: url.includes('/search'),
      searchPageReady,
      queryApplied: resultsFreshForExpectedQuery,
      historyVisible,
      rawSearchHistoryVisible,
      historyOverriddenByRealtime: false,
      staleHistoryWithoutQuery,
      realtimeResultStructure,
      resultsPresent,
      resultsFreshForExpectedQuery,
      playlistOnly,
      serviceLabels,
      candidateCount,
      searchValue: visibleQueryInInput ? expectedQuery : '',
      visibleQueryInInput,
      queryVisibleSomewhere,
      viewAllCount,
      playableButtonCount,
      structuralCardCount,
      serviceSectionCount,
      typeLabelCounts,
      typeLabelSignalCount,
      detailReady: false,
      detailKind: null,
      resultsPresentReasons,
      resultsAbsentReasons: [
        !url.includes('/search') ? 'not-on-search-page' : null,
        !searchPageReady ? 'search-page-not-ready' : null,
        !realtimeResultStructure ? 'missing-realtime-result-structure' : null,
        !resultsPresentReasons.length ? 'no-structural-results-combination-met-threshold' : null,
        expectedQuery && !queryVisibleSomewhere ? 'expected-query-not-visible-in-snapshot' : null,
      ].filter(Boolean),
      structuralSignals: {
        queryVisibleInInput: visibleQueryInInput,
        queryVisibleSomewhere,
        multipleResultCards: candidateCount >= 2,
        viewAllControls: viewAllCount > 0,
        playableButtons: playableButtonCount > 0,
        typeLabels: typeLabelSignalCount > 0,
        serviceSections: serviceSectionCount > 0,
      },
      bodyPreview: unique(names).join(' ').slice(0, 1200),
      visibleSearchBoxCount: searchInputs.length,
      activeElementRole: '',
      activeElementTag: '',
      activeElementValue: '',
      nonSearchInteractiveCount: nonExcludedClickables.length,
      analysisMode: 'aria-snapshot',
    },
    usableBlocks: {
      inputs: searchInputs,
      serviceTabs,
      candidates,
      clickables: clickables.slice(0, 120),
      menuActions,
      rows: [],
    },
    analysisMode: 'aria-snapshot',
  };
}

export function classifySearchPageStateFromAriaSnapshot(snapshotOrNodes = [], options = {}) {
  return analyzeAriaSnapshot(snapshotOrNodes, options).pageState;
}

export function extractUsablePageBlocksFromAriaSnapshot(snapshotOrNodes = []) {
  const analyzed = analyzeAriaSnapshot(snapshotOrNodes);
  return {
    url: analyzed.pageState.url,
    title: analyzed.pageState.title,
    bodyPreview: analyzed.pageState.bodyPreview,
    analysisMode: analyzed.analysisMode,
    usableBlocks: analyzed.usableBlocks,
  };
}
