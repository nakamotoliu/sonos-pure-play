import { normalizeText, normalizeWhitespace } from './normalize.mjs';
import { classifySearchPageStateFromAriaSnapshot } from './aria-snapshot-tools.mjs';

export const SEARCH_RESULTS_PAGE_KINDS = new Set([
  'SEARCH_RESULTS_MIXED',
  'SEARCH_RESULTS_PLAYLISTS',
]);

export function isSearchResultsPageKind(pageKind) {
  return SEARCH_RESULTS_PAGE_KINDS.has(String(pageKind || ''));
}

export function summarizeUnifiedSearchState(state) {
  if (!state) return {};
  return {
    pageKind: state.pageKind,
    searchPageReady: state.searchPageReady,
    queryApplied: state.queryApplied,
    historyVisible: state.historyVisible,
    realtimeResultStructure: state.realtimeResultStructure,
    resultsPresent: state.resultsPresent,
    resultsFreshForExpectedQuery: state.resultsFreshForExpectedQuery,
    playlistOnly: state.playlistOnly,
    serviceLabels: state.serviceLabels,
    candidateCount: state.candidateCount,
    searchValue: state.searchValue,
    visibleQueryInInput: state.visibleQueryInInput,
    typeLabelCounts: state.typeLabelCounts,
    viewAllCount: state.viewAllCount,
    playableButtonCount: state.playableButtonCount,
    structuralCardCount: state.structuralCardCount,
    resultsPresentReasons: state.resultsPresentReasons,
    resultsAbsentReasons: state.resultsAbsentReasons,
  };
}

function detectSearchPageStateInDom(options = {}) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const textOf = (el) => normalize(el?.getAttribute?.('aria-label') || el?.textContent || '');
  const classText = (el) => String(el?.className || '').toLowerCase();
  const attrText = (el, name) => String(el?.getAttribute?.(name) || '');
  const countMatches = (text, pattern) => (String(text || '').match(pattern) || []).length;
  const expectedQuery = normalize(options?.query || options?.expectedQuery || '');
  const url = location.href;
  const title = document.title || '';
  const main = document.querySelector('main') || document.body;
  const bodyText = normalize(document.body?.innerText || '');
  const mainText = normalize(main?.innerText || '');
  const interactiveSelector = 'button,[role="button"],a,[role="link"]';
  const containerSelector = 'li,article,section,[role="listitem"],[role="region"],[role="group"]';
  const resolveSectionHeading = (node) => {
    for (let current = node; current && current !== main && current !== document.body; current = current.parentElement) {
      const heading = textOf(current.querySelector?.('h1,h2,h3,h4,[role="heading"]'));
      if (heading) return heading;
    }
    return '';
  };

  const sectionKindOf = (value) => {
    const text = normalize(value).toLowerCase();
    if (/播放列表|歌单|playlist|精选|合集/.test(text)) return 'playlist';
    if (/专辑|album/.test(text)) return 'album';
    if (/艺术家|艺人|歌手|artist/.test(text)) return 'artist';
    if (/歌曲|单曲|track|song/.test(text)) return 'song';
    return 'unknown';
  };

  const searchInputs = [...document.querySelectorAll('input,textarea,[role="combobox"],[role="searchbox"]')]
    .filter((el) => visible(el) && (
      el.getAttribute('role') === 'combobox' ||
      el.getAttribute('role') === 'searchbox' ||
      el.type === 'search' ||
      /搜索/.test(attrText(el, 'placeholder'))
    ));
  const searchInput = searchInputs[0] || null;
  const searchValue = normalize(searchInput?.value || searchInput?.textContent || '');
  const onSearchPage = url.includes('/search');
  const searchPageReady = Boolean(onSearchPage && searchInput);
  const queryApplied = expectedQuery
    ? normalize(searchValue).includes(expectedQuery)
    : Boolean(searchValue);
  const visibleQueryInInput = queryApplied;
  const rawSearchHistoryVisible = /搜索记录/.test(bodyText);
  const staleHistoryWithoutQuery = Boolean(expectedQuery && !visibleQueryInInput && rawSearchHistoryVisible);

  const allContainers = [...main.querySelectorAll(containerSelector)].filter(visible);
  const containers = allContainers.map((container, index) => {
    const heading = textOf(container.querySelector('h1,h2,h3,h4,[role="heading"]'));
    const sectionHeading = heading || resolveSectionHeading(container);
    const text = textOf(container);
    const buttons = [...container.querySelectorAll(interactiveSelector)]
      .filter(visible)
      .map((node) => textOf(node))
      .filter(Boolean);
    const serviceMatches = [...new Set((`${heading} ${text}`.match(/网易云音乐|QQ音乐|Sonos Radio/g) || []).filter(Boolean))];
    const typeCounts = {
      playlist: countMatches(text, /(播放列表|歌单|playlist|精选|合集)/gi),
      album: countMatches(text, /(专辑|album)/gi),
      artist: countMatches(text, /(艺术家|艺人|歌手|artist)/gi),
      song: countMatches(text, /(歌曲|单曲|track|song)/gi),
    };
    const headingKind = sectionKindOf(heading);
    const dominantType = Object.entries(typeCounts)
      .filter(([, value]) => value > 0)
      .sort((left, right) => right[1] - left[1])[0]?.[0] || 'unknown';
    const sectionKind = headingKind !== 'unknown' ? headingKind : dominantType;
    const playCount = buttons.filter((label) => /^播放/.test(label)).length;
    const viewAllCount = buttons.filter((label) => /查看全部|查看所有|查看更多|展开/.test(label)).length;
    const typeHint = /(播放列表|歌单|playlist|精选|合集|专辑|艺术家|艺人|歌手|歌曲|单曲|热门)/.test(`${heading} ${text}`);
    const aggregationHint = /(歌曲|播放列表|歌单|专辑|艺术家|艺人|查看全部|查看所有|查看更多|展开)/.test(`${heading} ${text}`);
    return {
      index,
      heading,
      sectionHeading,
      text,
      serviceMatches,
      typeCounts,
      sectionKind,
      playCount,
      viewAllCount,
      typeHint,
      aggregationHint,
      inSearchHistorySection: /搜索记录/.test(sectionHeading),
      inServiceLibrarySection: /您的服务/.test(sectionHeading),
    };
  });

  const resultLikeContainers = containers.filter((entry) => !entry.inSearchHistorySection && !entry.inServiceLibrarySection);
  const aggregationContainers = resultLikeContainers.filter((entry) => entry.aggregationHint && (entry.viewAllCount > 0 || entry.playCount > 0));
  const candidateContainers = resultLikeContainers.filter((entry) => entry.typeHint && (entry.playCount > 0 || entry.viewAllCount > 0 || Object.values(entry.typeCounts).some((value) => value > 0)));
  const structuralCardCount = candidateContainers.length + aggregationContainers.length;
  const candidateCount = [...new Set([
    ...candidateContainers.map((entry) => entry.index),
    ...aggregationContainers.map((entry) => entry.index),
  ])].length;
  const typeLabelCounts = {
    playlist: countMatches(mainText, /(播放列表|歌单|playlist|精选|合集)/gi),
    album: countMatches(mainText, /(专辑|album)/gi),
    artist: countMatches(mainText, /(艺术家|艺人|歌手|artist)/gi),
    song: countMatches(mainText, /(歌曲|单曲|track|song)/gi),
  };
  const typeLabelSignalCount = Object.values(typeLabelCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const viewAllCount = countMatches(mainText, /(查看全部|查看所有|查看更多|展开)/gi);
  const playableButtonCount = [...document.querySelectorAll(interactiveSelector)]
    .filter(visible)
    .map((el) => textOf(el))
    .filter((label) => /^播放/.test(label))
    .length;
  const serviceLabels = [...new Set((mainText.match(/网易云音乐|QQ音乐/g) || []).filter(Boolean))];
  const serviceSectionCount = resultLikeContainers.filter((entry) => entry.serviceMatches.length > 0).length;

  const queryVisibleSomewhere = Boolean(expectedQuery) && (
    visibleQueryInInput ||
    mainText.includes(expectedQuery) ||
    bodyText.includes(expectedQuery)
  );

  const structuralSignals = {
    queryVisibleInInput: visibleQueryInInput,
    queryVisibleSomewhere,
    multipleResultCards: structuralCardCount >= 2,
    viewAllControls: viewAllCount > 0,
    playableButtons: playableButtonCount > 0,
    typeLabels: typeLabelSignalCount > 0,
    serviceSections: serviceSectionCount > 0 || serviceLabels.length > 0,
  };

  const strongResultStructure = Boolean(
    structuralSignals.multipleResultCards ||
    structuralSignals.viewAllControls ||
    structuralSignals.typeLabels ||
    structuralSignals.serviceSections
  );
  const realtimeResultStructure = Boolean(
    structuralSignals.multipleResultCards ||
    (structuralSignals.viewAllControls && (structuralSignals.playableButtons || structuralSignals.typeLabels || structuralSignals.serviceSections || structuralSignals.queryVisibleSomewhere)) ||
    (structuralSignals.playableButtons && (structuralSignals.typeLabels || structuralSignals.multipleResultCards)) ||
    (structuralSignals.typeLabels && (structuralSignals.multipleResultCards || structuralSignals.queryVisibleSomewhere || structuralSignals.serviceSections)) ||
    (structuralSignals.serviceSections && (structuralSignals.multipleResultCards || structuralSignals.viewAllControls || structuralSignals.playableButtons || structuralSignals.typeLabels))
  );

  const historyOverriddenByRealtime = Boolean(rawSearchHistoryVisible && realtimeResultStructure && !staleHistoryWithoutQuery);
  const historyVisible = Boolean(rawSearchHistoryVisible && (!historyOverriddenByRealtime || staleHistoryWithoutQuery));

  const resultsPresentChecks = [
    { ok: visibleQueryInInput && structuralSignals.multipleResultCards, reason: 'query-visible-plus-multiple-result-cards' },
    { ok: visibleQueryInInput && structuralSignals.viewAllControls, reason: 'query-visible-plus-view-all-controls' },
    { ok: visibleQueryInInput && structuralSignals.playableButtons && strongResultStructure, reason: 'query-visible-plus-playable-buttons' },
    { ok: structuralSignals.multipleResultCards && structuralSignals.typeLabels, reason: 'multiple-result-cards-plus-type-labels' },
    { ok: structuralSignals.multipleResultCards && structuralSignals.playableButtons, reason: 'multiple-result-cards-plus-playable-buttons' },
    { ok: structuralSignals.viewAllControls && structuralSignals.typeLabels, reason: 'view-all-controls-plus-type-labels' },
    { ok: structuralSignals.viewAllControls && structuralSignals.playableButtons, reason: 'view-all-controls-plus-playable-buttons' },
    { ok: structuralSignals.playableButtons && structuralSignals.typeLabels, reason: 'playable-buttons-plus-type-labels' },
    { ok: structuralSignals.serviceSections && (structuralSignals.multipleResultCards || structuralSignals.viewAllControls || structuralSignals.playableButtons || structuralSignals.typeLabels), reason: 'service-sections-plus-structural-results' },
  ];
  const resultsPresentReasons = resultsPresentChecks.filter((entry) => entry.ok).map((entry) => entry.reason);
  const resultsFreshForExpectedQuery = Boolean(
    onSearchPage &&
    realtimeResultStructure &&
    visibleQueryInInput &&
    resultsPresentReasons.length > 0 &&
    !staleHistoryWithoutQuery
  );
  const resultsAbsentReasons = [
    !onSearchPage ? 'not-on-search-page' : null,
    !searchPageReady ? 'search-page-not-ready' : null,
    !realtimeResultStructure ? 'missing-realtime-result-structure' : null,
    !resultsPresentReasons.length ? 'no-structural-results-combination-met-threshold' : null,
    expectedQuery && !visibleQueryInInput ? 'expected-query-not-visible-in-input' : null,
    historyVisible && !historyOverriddenByRealtime ? 'history-visible-without-realtime-override' : null,
  ].filter(Boolean);
  const resultsPresent = Boolean(onSearchPage && realtimeResultStructure && resultsPresentReasons.length > 0 && !staleHistoryWithoutQuery);

  const isNowPlaying = (el) => {
    if (!el) return false;
    if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) return true;
    if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return true;
    return attrText(el, 'aria-label').includes('正在播放');
  };
  const isSystem = (el) => !!el?.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]');
  const isTableDescendant = (el) => !!el?.closest('[role="table"],[role="row"],tr,[role="grid"],table');
  const interactiveEntries = [...document.querySelectorAll(interactiveSelector)]
    .filter(visible)
    .map((el, index) => ({ el, index, text: textOf(el) }));
  const scoreDetailContainer = (container) => {
    if (!container || !main.contains(container)) return null;
    const headingEl = container.querySelector('h1,h2,h3,h4,[role="heading"]');
    const heading = textOf(headingEl);
    const directButtons = interactiveEntries.filter(({ el }) => {
      if (isTableDescendant(el)) return false;
      const block = el.closest('button,[role="button"],a,[role="link"]');
      return block && container.contains(block);
    });
    const play = directButtons.find((entry) => /^播放/.test(entry.text));
    const more = directButtons.find((entry) => entry.text === '更多选项');
    const close = directButtons.find((entry) => entry.text === '关闭');
    const table = container.querySelector('[role="table"],[role="grid"],table');
    const trackLikeRows = [...container.querySelectorAll('li,article,section,div,[role="listitem"],[role="row"],tr')]
      .filter(visible)
      .map((node) => textOf(node))
      .filter((text) => text && /\d{2}\s+.+/.test(text) && /\d{1,2}:\d{2}/.test(text))
      .slice(0, 20);
    let score = 0;
    if (heading) score += 4;
    if (table) score += 4;
    if (more) score += 6;
    if (play) score += 4;
    if (close) score += 2;
    if (trackLikeRows.length >= 3) score += 5;
    return {
      heading,
      tablePresent: Boolean(table),
      trackLikeRowCount: trackLikeRows.length,
      moreOptionsIndex: more?.index ?? null,
      playIndex: play?.index ?? null,
      score,
    };
  };
  const detailCandidate = [...main.querySelectorAll('main > div, main > section, main > article, main > [role="region"], main > [role="group"], main > *')]
    .filter(visible)
    .map(scoreDetailContainer)
    .filter(Boolean)
    .filter((entry) => {
      if (!entry.heading) return false;
      if (entry.moreOptionsIndex != null && entry.tablePresent) return true;
      return entry.playIndex != null && entry.trackLikeRowCount >= 3;
    })
    .sort((left, right) => right.score - left.score)[0] || null;
  const isPlaylistDetailUrl = /\/browse\/services\/.*\/playlist\//.test(url);
  const isServiceDetailUrl = /\/browse\/services\//.test(url);
  const detailReady = Boolean(isServiceDetailUrl && detailCandidate);
  const playlistOnly = Boolean(
    url.includes('view=PLAYLISTS') ||
    (resultsPresent && typeLabelCounts.playlist > 0 && typeLabelCounts.album === 0 && typeLabelCounts.artist === 0 && typeLabelCounts.song === 0)
  );

  const pageKind =
    detailReady && isPlaylistDetailUrl ? 'PLAYLIST_DETAIL_READY' :
    detailReady ? 'CONTENT_DETAIL_READY' :
    resultsPresent && playlistOnly ? 'SEARCH_RESULTS_PLAYLISTS' :
    resultsPresent ? 'SEARCH_RESULTS_MIXED' :
    historyVisible ? 'SEARCH_HISTORY' :
    onSearchPage ? 'SEARCH_READY' :
    url.includes('/web-app') ? 'APP_HOME' :
    'UNKNOWN';

  return {
    pageKind,
    url,
    title,
    onSearchPage,
    searchPageReady,
    queryApplied,
    historyVisible,
    rawSearchHistoryVisible,
    historyOverriddenByRealtime,
    staleHistoryWithoutQuery,
    realtimeResultStructure,
    resultsPresent,
    resultsFreshForExpectedQuery,
    playlistOnly,
    serviceLabels,
    candidateCount,
    searchValue,
    visibleQueryInInput,
    queryVisibleSomewhere,
    viewAllCount,
    playableButtonCount,
    structuralCardCount,
    serviceSectionCount,
    typeLabelCounts,
    typeLabelSignalCount,
    detailReady,
    detailKind: detailReady ? (isPlaylistDetailUrl ? 'playlist' : 'generic') : null,
    resultsPresentReasons,
    resultsAbsentReasons,
    structuralSignals,
    bodyPreview: bodyText.slice(0, 800),
    visibleSearchBoxCount: searchInputs.length,
    activeElementRole: attrText(document.activeElement, 'role'),
    activeElementTag: document.activeElement?.tagName || '',
    activeElementValue: normalize(document.activeElement?.value || document.activeElement?.textContent || ''),
    nonSearchInteractiveCount: interactiveEntries.filter(({ el }) => !isNowPlaying(el) && !isSystem(el)).length,
  };
}

export function buildDetectSearchPageStateFn(options = {}) {
  return `() => (${detectSearchPageStateInDom.toString()})(${JSON.stringify(options)})`;
}

export function classifySearchPageState(state = {}) {
  const pageKind = String(state?.pageKind || '');
  return {
    ...state,
    isResultsPage: isSearchResultsPageKind(pageKind),
    isDetailPage: ['PLAYLIST_DETAIL_READY', 'CONTENT_DETAIL_READY'].includes(pageKind),
    isSearchHistoryOnly: pageKind === 'SEARCH_HISTORY' && !state?.resultsPresent,
    readyForCandidateExtraction: Boolean(
      (state?.resultsFreshForExpectedQuery ?? state?.resultsPresent) &&
      isSearchResultsPageKind(pageKind)
    ),
  };
}

export function matchesExpectedQuery(state = {}, query = '') {
  const normalizedQuery = normalizeText(query || '');
  if (!normalizedQuery) return Boolean(state?.queryApplied);
  const searchValue = normalizeText(state?.searchValue || '');
  const preview = normalizeText(state?.bodyPreview || '');
  return Boolean(
    searchValue.includes(normalizedQuery) ||
    preview.includes(normalizedQuery) ||
    state?.queryApplied
  );
}

export function describeUnifiedSearchState(state = {}) {
  const summary = summarizeUnifiedSearchState(state);
  return normalizeWhitespace(JSON.stringify(summary));
}

export { classifySearchPageStateFromAriaSnapshot };
