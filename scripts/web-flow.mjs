import { normalizeMenuLabel, normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';
import { rankCandidates } from './candidate-ranker.mjs';
import { scoreHistoryPenalty } from './playback-memory.mjs';
import { ACTION_PRIORITY, SEARCH_URL } from './selectors.mjs';

const BLOCKED_RESULT_PATTERNS = /sonos radio|tunein|直播|电台|广播|更多选项|播放群组|暂停群组|上一首|下一首|设置为有效|搜索记录|查看全部|查看所有|刷新|退出/i;
const BLOCKED_SOURCE_PATTERNS = /sonos radio|tunein|站点|radio|\bfm\b/i;
const REAL_SERVICE_PATTERN = /网易云音乐|QQ音乐/;
const NON_SONOS_SERVICE_PATTERN = /网易云音乐|QQ音乐/;
const ROOM_CONTROL_PATTERNS = /群组|房间|音量|设置为有效|客厅|工作室|卧室|厨房|书房/;
const BLOCKED_ZONES = new Set(['system-controls', 'now-playing-bar']);
const DEFAULT_MIN_CANDIDATE_SCORE = 12;
const MIN_VIEW_ALL_SELECTION_SCORE = 6;
const TITLE_BLOCKLIST = /更多选项|查看全部|查看所有|查看更多|返回|首页|设置为有效|群组|房间|音量/;
const VIEW_ALL_LABELS = /查看全部|查看所有|查看更多|展开/;
const DIRTY_SHELL_SIGNALS = /最近播放|您的服务|Sonos收藏夹|您的信号源|线路输入/;
const TYPE_LABELS = {
  playlist: /(播放列表|歌单|playlist|精选|合集)/i,
  album: /(专辑|album)/i,
  artist: /(艺术家|艺人|歌手|artist)/i,
  song: /(歌曲|单曲|track|song)/i,
};

function tokenizeForMatching(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function nodeText(node) {
  return normalizeWhitespace(`${node?.name || ''} ${node?.value || ''}`);
}

function scoreResult(node, query) {
  const text = nodeText(node);
  const normalized = normalizeText(text);
  const tokens = normalizeText(query).split(' ').filter(Boolean);

  let score = 0;
  if (!normalized) return score;
  if (/sonos radio|tunein|直播|电台|查看更多|广播/.test(normalized)) score -= 100;
  if (/网易云音乐/.test(text)) score += 30;
  if (/QQ音乐/.test(text)) score += 18;
  if (/播放/.test(text)) score += 20;
  for (const token of tokens) {
    if (normalized.includes(token)) score += 12;
  }
  return score;
}

function splitTitleParts(value) {
  return normalizeWhitespace(value)
    .split(/[·•|/]| - | — |–/g)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function cleanContextText(value) {
  return normalizeWhitespace(value)
    .replace(/网易云音乐|QQ音乐/g, ' ')
    .replace(/播放|更多选项|查看全部|查看所有|查看更多/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestTitle(candidates) {
  const unique = [...new Set(candidates.map((entry) => normalizeWhitespace(entry)).filter(Boolean))];
  if (!unique.length) return '';

  const ranked = unique
    .map((title) => {
      let score = 0;
      if (title.length >= 2 && title.length <= 26) score += 10;
      if (title.length <= 40) score += 4;
      if (/(播放列表|歌单|专辑|热门|精选|热歌|歌曲|单曲|艺人|歌手|艺术家)/.test(title)) score += 3;
      if (TITLE_BLOCKLIST.test(title)) score -= 20;
      if (BLOCKED_RESULT_PATTERNS.test(title)) score -= 20;
      if (/网易云音乐|QQ音乐/.test(title)) score -= 10;
      return { title, score };
    })
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.title || '';
}

function deriveCandidateTitle({ clickLabel, scopeText, sectionLabel }) {
  const label = normalizeWhitespace(clickLabel || '');
  const labelTitle = normalizeWhitespace(label.replace(/^播放/, '')).trim();
  const candidates = [];

  if (labelTitle && labelTitle !== '播放') {
    candidates.push(labelTitle);
    candidates.push(...splitTitleParts(labelTitle));
  }

  const context = cleanContextText([scopeText, sectionLabel].filter(Boolean).join(' '));
  if (context) {
    candidates.push(context);
    candidates.push(...splitTitleParts(context));
  }

  return pickBestTitle(candidates);
}

function inferEntrySectionKind(entry) {
  const containerKind = normalizeWhitespace(entry?.containerSectionKind || '');
  if (containerKind && containerKind !== 'unknown') {
    return {
      sectionKind: containerKind,
      sectionKindSource: entry?.containerSectionKindSource || 'container',
    };
  }

  const inferred = inferSectionKind([
    entry?.sectionLabel,
    entry?.containerHeading,
    entry?.scopeText,
    entry?.text,
  ].filter(Boolean).join(' '));
  if (inferred !== 'unknown') return { sectionKind: inferred, sectionKindSource: 'content-fallback' };
  return { sectionKind: 'unknown', sectionKindSource: entry?.containerSectionKindSource || 'unknown' };
}

function deriveCandidateGroupKey(entry) {
  if (!entry) return null;
  if (Number.isFinite(entry.containerIndex) && entry.containerIndex >= 0) return `container:${entry.containerIndex}`;
  if (!['play', 'open-detail', 'expand'].includes(entry.controlRole)) return null;

  const derivedTitle = deriveCandidateTitle({
    clickLabel: entry.text,
    scopeText: entry.scopeText,
    sectionLabel: entry.sectionLabel || entry.containerHeading || '',
  });
  const keyText = normalizeText(derivedTitle || entry.text || entry.scopeText || entry.sectionLabel || '');
  if (!keyText) return null;
  return `${entry.controlRole}:${keyText}`;
}

function hasMediaIdentitySignal(value) {
  const haystack = normalizeWhitespace(value || '');
  if (!haystack) return false;
  return (
    /(播放列表|歌单|playlist|精选|合集|专辑|艺术家|艺人|歌手|歌曲|单曲|网易云音乐|QQ音乐)/i.test(haystack) ||
    /^播放\S+/.test(haystack)
  );
}

function isRoomControlNoise(entry) {
  const haystack = [entry?.title, entry?.clickLabel, entry?.scopeText, entry?.sectionLabel].filter(Boolean).join(' ');
  return ROOM_CONTROL_PATTERNS.test(haystack) && !hasMediaIdentitySignal(haystack);
}

function isBlockedResultNoise(entry) {
  const haystack = [entry?.title, entry?.clickLabel, entry?.scopeText, entry?.sectionLabel, entry?.service].filter(Boolean).join(' ');
  return BLOCKED_RESULT_PATTERNS.test(haystack) && !hasMediaIdentitySignal(haystack);
}

function isAllowedMusicSource(entry) {
  const haystack = normalizeWhitespace([
    entry?.service,
    entry?.title,
    entry?.clickLabel,
    entry?.scopeText,
    entry?.sectionLabel,
  ].filter(Boolean).join(' '));
  if (!haystack) return false;
  if (BLOCKED_SOURCE_PATTERNS.test(haystack)) return false;
  return NON_SONOS_SERVICE_PATTERN.test(haystack);
}

function readContentContext(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const classText = (el) => String(el?.className || '').toLowerCase();
      const attrText = (el, name) => String(el?.getAttribute(name) || '');
      const url = location.href;
      const title = document.title || '';
      const main = document.querySelector('main') || document.body;
      const bodyText = normalize(document.body?.innerText || '');
      const mainText = normalize(main?.innerText || '');
      const interactiveSelector = 'button,[role="button"],a,[role="link"]';
      const containerSelector = 'li,article,section,[role="listitem"],[role="region"],[role="group"]';
      const sectionKindOf = (value) => {
        const text = normalize(value).toLowerCase();
        if (/播放列表|歌单|playlist|精选|合集/.test(text)) return 'playlist';
        if (/专辑|album/.test(text)) return 'album';
        if (/艺术家|艺人|歌手|artist/.test(text)) return 'artist';
        if (/歌曲|单曲|track|song/.test(text)) return 'song';
        return 'unknown';
      };
      const countMatches = (text, pattern) => (text.match(pattern) || []).length;
      const isNowPlaying = (el) => {
        if (!el) return false;
        if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) return true;
        if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return true;
        return attrText(el, 'aria-label').includes('正在播放');
      };
      const isSystem = (el) => !!el?.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]');

      const serviceOf = (value) => /网易云音乐|QQ音乐|Sonos Radio/.exec(normalize(value))?.[0] || '';
      const allContainers = [...main.querySelectorAll(containerSelector)].filter(visible);
      const containers = allContainers.map((container, index) => {
        const heading = textOf(container.querySelector('h1,h2,h3,h4,[role="heading"]'));
        const text = textOf(container);
        const buttons = [...container.querySelectorAll(interactiveSelector)]
          .filter(visible)
          .map((node) => textOf(node))
          .filter(Boolean);
        const service = serviceOf([heading, text].join(' '));
        const typeHint = /(播放列表|歌单|专辑|艺术家|艺人|歌曲|单曲|热门|精选)/.test([heading, text].join(' '));
        const typeCounts = {
          playlist: countMatches(text, /(播放列表|歌单|playlist|精选|合集)/gi),
          album: countMatches(text, /(专辑|album)/gi),
          artist: countMatches(text, /(艺术家|艺人|歌手|artist)/gi),
          song: countMatches(text, /(歌曲|单曲|track|song)/gi),
        };
        const headingKind = sectionKindOf(heading);
        const inferredKind = (() => {
          const entries = Object.entries(typeCounts).filter(([, value]) => value > 0);
          if (entries.length === 1 && entries[0][1] >= 1) return entries[0][0];
          const dominant = entries.sort((a, b) => b[1] - a[1])[0];
          if (dominant && dominant[1] >= 2) return dominant[0];
          return 'unknown';
        })();
        const sectionKind = headingKind !== 'unknown' ? headingKind : inferredKind;
        const sectionKindSource = headingKind !== 'unknown' ? 'heading' : inferredKind !== 'unknown' ? 'type-density' : 'unknown';
        const playCount = buttons.filter((label) => /^播放/.test(label)).length;
        const viewAllCount = buttons.filter((label) => /查看全部|查看所有|查看更多|展开/.test(label)).length;
        const moreCount = buttons.filter((label) => label === '更多选项').length;
        const aggregationHint = /(歌曲|播放列表|歌单|专辑|艺术家|艺人|查看全部|查看所有|查看更多)/.test([heading, text].join(' '));
        return {
          index,
          heading,
          text,
          textSample: text.slice(0, 320),
          service,
          typeHint,
          typeCounts,
          sectionKind,
          sectionKindSource,
          playCount,
          viewAllCount,
          moreCount,
          aggregationHint,
        };
      });

      const aggregationContainers = containers.filter((entry) => entry.aggregationHint && (entry.viewAllCount > 0 || entry.playCount > 1));
      const candidateContainers = containers.filter((entry) => entry.typeHint && (entry.playCount > 0 || entry.viewAllCount > 0));
      const typeLabelCounts = {
        playlist: countMatches(mainText, /(播放列表|歌单|playlist|精选|合集)/gi),
        album: countMatches(mainText, /(专辑|album)/gi),
        artist: countMatches(mainText, /(艺术家|艺人|歌手|artist)/gi),
        song: countMatches(mainText, /(歌曲|单曲|track|song)/gi),
      };
      const viewAllCount = countMatches(mainText, /(查看全部|查看所有|查看更多|展开)/gi);
      const serviceLabels = [...new Set((mainText.match(/网易云音乐|QQ音乐/g) || []).filter(Boolean))];
      const resultsPresent =
        url.includes('/search') && (
          (candidateContainers.length >= 2 && (typeLabelCounts.playlist + typeLabelCounts.album + typeLabelCounts.artist + typeLabelCounts.song) >= 1) ||
          (serviceLabels.length > 0 && viewAllCount > 0 && (typeLabelCounts.playlist + typeLabelCounts.album + typeLabelCounts.artist + typeLabelCounts.song) >= 1) ||
          (candidateContainers.length >= 2 && viewAllCount > 0)
        );
      const searchHistory = /搜索记录/.test(bodyText);
      const searchShellDirty = /最近播放|您的服务|Sonos收藏夹|您的信号源|线路输入/.test(bodyText);
      const playlistOnly =
        url.includes('view=PLAYLISTS') ||
        (resultsPresent && typeLabelCounts.playlist > 0 && typeLabelCounts.album === 0 && typeLabelCounts.artist === 0 && typeLabelCounts.song === 0);

      const zoneFor = (el, containerIndex) => {
        if (!el) return 'unknown';
        if (isNowPlaying(el)) return 'now-playing-bar';
        if (isSystem(el)) return 'system-controls';
        if (el.closest('main')) return aggregationContainers.length ? 'full-results' : 'search-results';
        return 'unknown';
      };

      const controls = [...document.querySelectorAll(interactiveSelector)]
        .filter(visible)
        .map((el, index) => {
          const container = el.closest(containerSelector);
          const containerIndex = container ? allContainers.indexOf(container) : -1;
          const containerMeta = containerIndex >= 0 ? containers[containerIndex] : null;
          const text = textOf(el);
          let controlRole = 'other';
          if (/查看全部|查看所有|查看更多|展开/.test(text)) controlRole = 'expand';
          else if (text === '更多选项') controlRole = 'more-options';
          else if (/^播放/.test(text)) controlRole = 'play';
          else if (text && !/返回|首页|关闭|刷新|退出/.test(text)) controlRole = 'open-detail';
          return {
            index,
            text,
            zone: zoneFor(el, containerIndex),
            controlRole,
            containerIndex,
            scopeText: containerMeta?.text || textOf(el.parentElement),
            sectionLabel: containerMeta?.heading || textOf(container?.closest('section,[role="region"],[role="group"]')?.querySelector('h1,h2,h3,h4,[role="heading"]')) || '',
            service: containerMeta?.service || serviceOf([text, textOf(container), textOf(el.parentElement), textOf(el.parentElement?.parentElement), textOf(el.parentElement?.parentElement?.parentElement)].join(' ')),
            containerText: containerMeta?.text || '',
            containerTextSample: containerMeta?.textSample || '',
            containerSectionKind: containerMeta?.sectionKind || 'unknown',
            containerSectionKindSource: containerMeta?.sectionKindSource || 'unknown',
            containerAggregationHint: !!containerMeta?.aggregationHint,
            containerHasMoreOptions: Boolean(containerMeta?.moreCount),
            containerHeading: containerMeta?.heading || '',
            containerTypeHint: Boolean(containerMeta?.typeHint),
            containerTypeCounts: containerMeta?.typeCounts || {},
          };
        });

      const sections = containers
        .filter((entry) => entry.aggregationHint || entry.viewAllCount > 0 || entry.typeHint)
        .map((entry) => ({
          containerIndex: entry.index,
          heading: entry.heading,
          sectionKind: entry.sectionKind,
          sectionKindSource: entry.sectionKindSource,
          typeCounts: entry.typeCounts,
          viewAllButtons: controls
            .filter((control) => control.containerIndex === entry.index && control.controlRole === 'expand')
            .map((control) => ({ index: control.index, text: control.text, zone: control.zone })),
          textSample: entry.textSample,
        }));

      const structuralDetail = (() => {
        const visibleButtons = [...document.querySelectorAll(interactiveSelector)].filter(visible);
        const interactiveEntries = visibleButtons.map((el, index) => ({ el, index, text: textOf(el) }));
        const isTableDescendant = (el) => !!el?.closest('[role="table"],[role="row"],tr,[role="grid"],table');
        const scoreContainer = (container) => {
          if (!container || !main.contains(container)) return null;
          const headingEl = container.querySelector('h1,h2,h3,h4,[role="heading"]');
          const heading = textOf(headingEl);
          const service = serviceOf(textOf(container));
          const directButtons = interactiveEntries.filter(({ el }) => {
            if (isTableDescendant(el)) return false;
            const block = el.closest('button,[role="button"],a,[role="link"]');
            return block && container.contains(block);
          });
          const play = directButtons.find((entry) => /^播放/.test(entry.text));
          const shuffle = directButtons.find((entry) => /随机播放/.test(entry.text));
          const more = directButtons.find((entry) => entry.text === '更多选项');
          const table = container.querySelector('[role="table"],[role="grid"],table');
          const headingBeforeTable = headingEl && table
            ? Boolean(headingEl.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
            : Boolean(headingEl);
          const moreBeforeTable = more?.el && table
            ? Boolean(more.el.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
            : Boolean(more);
          const playBeforeTable = play?.el && table
            ? Boolean(play.el.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
            : Boolean(play);
          let score = 0;
          if (heading) score += 4;
          if (service) score += 3;
          if (table) score += 4;
          if (more) score += 6;
          if (play) score += 5;
          if (shuffle) score += 2;
          if (headingBeforeTable) score += 3;
          if (moreBeforeTable) score += 6;
          if (playBeforeTable) score += 4;
          if (more && isTableDescendant(more.el)) score -= 20;
          if (play && isTableDescendant(play.el)) score -= 20;
          return {
            element: container,
            heading,
            service,
            tablePresent: Boolean(table),
            headingBeforeTable,
            moreBeforeTable,
            playBeforeTable,
            playIndex: play?.index ?? null,
            shuffleIndex: shuffle?.index ?? null,
            moreOptionsIndex: more?.index ?? null,
            playLabel: play?.text || null,
            shuffleLabel: shuffle?.text || null,
            moreLabel: more?.text || null,
            buttonsCount: directButtons.length,
            score,
          };
        };

        const candidates = [...main.querySelectorAll('main > div, main > section, main > article, main > [role="region"], main > [role="group"], main > *')]
          .filter(visible)
          .map(scoreContainer)
          .filter(Boolean)
          .filter((entry) => entry.moreOptionsIndex != null && entry.playIndex != null && entry.heading && entry.tablePresent)
          .sort((left, right) => right.score - left.score);
        return candidates[0] || null;
      })();

      const detailActionArea = structuralDetail ? {
        index: -1,
        heading: structuralDetail.heading,
        service: structuralDetail.service,
        hasHeading: Boolean(structuralDetail.heading),
        aggregationResidual: false,
        playIndex: structuralDetail.playIndex,
        shuffleIndex: structuralDetail.shuffleIndex,
        moreOptionsIndex: structuralDetail.moreOptionsIndex,
        playLabel: structuralDetail.playLabel,
        shuffleLabel: structuralDetail.shuffleLabel,
        moreLabel: structuralDetail.moreLabel,
        buttonsCount: structuralDetail.buttonsCount,
        structural: {
          tablePresent: structuralDetail.tablePresent,
          headingBeforeTable: structuralDetail.headingBeforeTable,
          moreBeforeTable: structuralDetail.moreBeforeTable,
          playBeforeTable: structuralDetail.playBeforeTable,
          score: structuralDetail.score,
        },
      } : null;
      const isPlaylistDetailUrl = /\\/browse\\/services\\/.*\\/playlist\\//.test(url);
      const isServiceDetailUrl = /\\/browse\\/services\\//.test(url);
      const detailReady = Boolean(isServiceDetailUrl && detailActionArea && detailActionArea.moreOptionsIndex != null);
      const detailKind = detailReady ? (isPlaylistDetailUrl ? 'playlist' : 'generic') : null;

      const pageKind =
        detailReady && detailKind === 'playlist' ? 'PLAYLIST_DETAIL_READY' :
        detailReady ? 'CONTENT_DETAIL_READY' :
        searchHistory ? 'SEARCH_HISTORY' :
        searchShellDirty ? 'SEARCH_SHELL_DIRTY' :
        resultsPresent && playlistOnly ? 'SEARCH_RESULTS_PLAYLISTS' :
        resultsPresent ? 'SEARCH_RESULTS_MIXED' :
        url.includes('/search') ? 'SEARCH_READY' :
        url.includes('/web-app') ? 'APP_HOME' :
        'UNKNOWN';

      return {
        url,
        title,
        pageKind,
        resultsPresent,
        searchHistory,
        searchShellDirty,
        playlistOnly,
        typeLabelCounts,
        viewAllCount,
        serviceLabels,
        candidateCount: candidateContainers.length,
        sections,
        detail: detailReady ? {
          playlistTitle: detailActionArea?.heading || '',
          service: detailActionArea?.service || '',
          actionArea: detailActionArea,
          kind: detailKind,
          structural: detailActionArea?.structural || null,
        } : null,
        aggregationContainers: aggregationContainers.map((entry) => ({
          index: entry.index,
          heading: entry.heading,
          sectionKind: entry.sectionKind,
          textSample: entry.textSample,
        })),
        controls,
        bodyPreview: bodyText.slice(0, 800),
      };
    }`
  );
  return result?.result || result;
}

function buildContainerCandidates(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    if (BLOCKED_ZONES.has(entry.zone)) continue;
    const key = deriveCandidateGroupKey(entry);
    if (!key) continue;
    const inferredSection = inferEntrySectionKind(entry);
    if (!grouped.has(key)) {
      grouped.set(key, {
        containerIndex: entry.containerIndex,
        scopeText: entry.scopeText,
        sectionLabel: entry.sectionLabel || entry.containerHeading || '',
        service: entry.service || entry.inheritedService || '',
        zone: entry.zone,
        sectionKind: inferredSection.sectionKind,
        sectionKindSource: inferredSection.sectionKindSource,
        type: inferCandidateType({
          sectionLabel: entry.sectionLabel || entry.containerHeading || '',
          scopeText: entry.scopeText,
          text: entry.text,
        }),
        directPlayTarget: null,
        expandTarget: null,
        openDetailTarget: null,
        moreOptionsTarget: null,
      });
    }
    const candidate = grouped.get(key);
    candidate.scopeText = candidate.scopeText || entry.scopeText;
    candidate.sectionLabel = candidate.sectionLabel || entry.sectionLabel || entry.containerHeading || '';
    candidate.service = candidate.service || entry.service || entry.inheritedService || '';
    candidate.zone = candidate.zone || entry.zone;
    if (!Number.isFinite(candidate.containerIndex) || candidate.containerIndex < 0) {
      candidate.containerIndex = entry.containerIndex;
    }
    if (candidate.sectionKind === 'unknown' && inferredSection.sectionKind !== 'unknown') {
      candidate.sectionKind = inferredSection.sectionKind;
      candidate.sectionKindSource = inferredSection.sectionKindSource;
    }
    if (entry.controlRole === 'play' && !candidate.directPlayTarget) {
      candidate.directPlayTarget = { index: entry.index, clickLabel: entry.text, controlRole: entry.controlRole };
    } else if (entry.controlRole === 'expand' && !candidate.expandTarget) {
      candidate.expandTarget = { index: entry.index, clickLabel: entry.text, controlRole: entry.controlRole };
    } else if (entry.controlRole === 'more-options' && !candidate.moreOptionsTarget) {
      candidate.moreOptionsTarget = { index: entry.index, clickLabel: entry.text, controlRole: entry.controlRole };
    } else if (
      entry.controlRole === 'open-detail' &&
      !BLOCKED_RESULT_PATTERNS.test(entry.text) &&
      !ROOM_CONTROL_PATTERNS.test(entry.text) &&
      !REAL_SERVICE_PATTERN.test(entry.text) &&
      entry.text.length >= 2
    ) {
      const preferred = !candidate.openDetailTarget || entry.text.length > candidate.openDetailTarget.clickLabel.length;
      if (preferred) {
        candidate.openDetailTarget = { index: entry.index, clickLabel: entry.text, controlRole: entry.controlRole };
      }
    }
  }
  return [...grouped.values()].map((candidate) => {
    const title = deriveCandidateTitle({
      clickLabel: candidate.openDetailTarget?.clickLabel || candidate.directPlayTarget?.clickLabel || '',
      scopeText: candidate.scopeText,
      sectionLabel: candidate.sectionLabel,
    });
    return { ...candidate, title };
  });
}

function findSearchInput(nodes) {
  return nodes.find((node) => ['combobox', 'textbox', 'searchbox'].includes(node.role)) || null;
}

function inspectSearchSurface(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const bodyText = (document.body?.innerText || '').trim();
      const inputs = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="combobox"],[role="searchbox"]')];
      const hasInput = inputs.length > 0;
      const resultButtons = [...document.querySelectorAll('button')]
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter(Boolean);
      const hasPlayableButton = resultButtons.some((text) => /^播放/.test(text));
      const hasSearchHistory = /搜索记录/.test(bodyText);
      const hasRenderedResults =
        /网易云音乐|QQ音乐/.test(bodyText) &&
        /(播放列表|专辑|艺术家|歌曲|查看全部|查看更多)/.test(bodyText);
      return {
        hasInput,
        hasPlayableButton,
        hasSearchHistory,
        hasRenderedResults,
        bodyPreview: bodyText.slice(0, 800),
      };
    }`
  );
  return result?.result || result;
}

function diagnose(runner, targetId, phase, locatorRule, missReason) {
  const state = runner.readPageState(targetId);
  return { phase, locatorRule, missReason, state };
}

function readSearchHealth(runner, targetId) {
  const state = runner.readPageState(targetId);
  const surface = inspectSearchSurface(runner, targetId);
  const context = readContentContext(runner, targetId);
  const bodyPreview = String(surface?.bodyPreview || context?.bodyPreview || '').trim();
  const pageKind = context?.pageKind || 'UNKNOWN';
  const onSearchUrl = String(state?.url || '').includes('/search');
  const hasInput = Boolean(surface?.hasInput);
  const hasResults = Boolean(surface?.hasRenderedResults || surface?.hasPlayableButton || context?.resultsPresent);
  const hasSearchHistory = Boolean(surface?.hasSearchHistory || context?.searchHistory);
  const shellDirty = Boolean(context?.searchShellDirty);
  const blankShell = onSearchUrl && !hasInput && !hasResults && !hasSearchHistory && !bodyPreview;
  const status = blankShell
    ? 'blank-shell'
    : shellDirty
      ? 'dirty-shell'
      : hasResults
        ? 'results'
        : hasSearchHistory
          ? 'history'
          : hasInput && onSearchUrl
            ? 'ready'
            : onSearchUrl
              ? 'search-no-input'
              : 'off-search';
  return {
    state,
    surface,
    context,
    pageKind,
    bodyPreview,
    onSearchUrl,
    hasInput,
    hasResults,
    hasSearchHistory,
    shellDirty,
    blankShell,
    status,
  };
}

function ensureSearchReady(runner, targetId, log, options = {}) {
  const { forceNavigate = false } = options;
  const before = readSearchHealth(runner, targetId);
  log({ ok: true, phase: 'page-state', state: before.state });
  log({ ok: true, phase: 'search-ready', event: 'health-before', health: {
    status: before.status,
    pageKind: before.pageKind,
    onSearchUrl: before.onSearchUrl,
    hasInput: before.hasInput,
    hasResults: before.hasResults,
    hasSearchHistory: before.hasSearchHistory,
    shellDirty: before.shellDirty,
    blankShell: before.blankShell,
    bodyPreview: before.bodyPreview,
  }});

  if (!forceNavigate && before.onSearchUrl && before.hasInput && !before.shellDirty && !before.blankShell) {
    log({ ok: true, phase: 'search-ready', event: 'reuse-existing-search-surface', reason: before.status });
    return before;
  }

  if (before.onSearchUrl) {
    const closeResult = runner.evaluate(
      targetId,
      `() => {
        const buttons = [
          ...document.querySelectorAll('button[aria-label="关闭"]'),
          ...document.querySelectorAll('button[aria-label="Close"]')
        ];
        const target = buttons[0];
        if (!target) return { ok: true, closed: false };
        target.click();
        return { ok: true, closed: true, label: target.getAttribute('aria-label') || target.textContent || '' };
      }`
    );
    log({ ok: true, phase: 'search-ready', event: 'close-stale-layer', result: closeResult?.result || closeResult });
    runner.waitMs(600);

    const dirtyState = runner.evaluate(
      targetId,
      `() => {
        const bodyText = (document.body?.innerText || '').trim();
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const textOf = (el) => ((el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim());
        const buttons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .filter(visible)
          .map((el) => textOf(el))
          .filter(Boolean);
        return {
          stillDirty:
            /错误/.test(bodyText) ||
            buttons.includes('返回') ||
            buttons.includes('首页') ||
            /将.+设置为有效/.test(bodyText),
          bodyPreview: bodyText.slice(0, 600),
          buttons: buttons.slice(0, 30),
        };
      }`
    );
    const dirty = dirtyState?.result || dirtyState;
    log({ ok: true, phase: 'search-ready', event: 'post-close-state', state: dirty });

    if (dirty?.stillDirty) {
      const backResult = runner.clickButtonByLabel(targetId, ['返回']);
      log({ ok: true, phase: 'search-ready', event: 'click-back', result: backResult });
      runner.waitMs(800);

      const homeResult = runner.clickButtonByLabel(targetId, ['首页']);
      log({ ok: true, phase: 'search-ready', event: 'click-home', result: homeResult });
      runner.waitMs(1000);
    }
  }

  runner.navigate(targetId, SEARCH_URL);
  const after = readSearchHealth(runner, targetId);
  log({ ok: true, phase: 'search-ready', event: 'health-after-navigate', health: {
    status: after.status,
    pageKind: after.pageKind,
    onSearchUrl: after.onSearchUrl,
    hasInput: after.hasInput,
    hasResults: after.hasResults,
    hasSearchHistory: after.hasSearchHistory,
    shellDirty: after.shellDirty,
    blankShell: after.blankShell,
    bodyPreview: after.bodyPreview,
  }});
  return after;
}

function syncActiveRoom(runner, targetId, room, log) {
  const maxAttempts = 4;
  let lastState = null;
  let lastClickResult = null;

  const roomSignals = (state) => {
    const roomCards = Array.isArray(state?.roomCardSamples) ? state.roomCardSamples : [];
    const confirmSignals = Array.isArray(state?.confirmSignals) ? state.confirmSignals : [];
    const bodyPreview = String(state?.bodyPreview || '');
    return {
      roomCards,
      confirmSignals,
      bodyPreview,
      roomMentioned:
        Boolean(state?.roomVisible) ||
        roomCards.some((text) => String(text || '').includes(room)) ||
        confirmSignals.includes('room-mentioned-on-page') ||
        bodyPreview.includes(room),
      buttonSeen: Boolean(state?.activateButtonVisible),
      outputControlsSeen: Boolean(state?.roomCardHasOutputControls) || confirmSignals.includes('room-card-has-output-controls'),
      pageBlankish: !bodyPreview.trim() && roomCards.length === 0 && confirmSignals.length <= 1,
    };
  };

  const isSoftConfirmed = (state, clickResult) => {
    const signals = roomSignals(state);
    if (!clickResult?.ok) return false;
    return Boolean(signals.roomMentioned || signals.outputControlsSeen);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = runner.readRoomSyncState(targetId, room);
    lastState = before;
    const beforeSignals = roomSignals(before);
    log({ ok: true, phase: 'active-room-sync', attempt, room, state: before, signals: beforeSignals });

    if (before.activeRoomConfirmed) {
      log({
        ok: true,
        phase: 'active-room-sync',
        attempt,
        room,
        event: 'already-confirmed',
        confirmSignals: before.confirmSignals,
      });
      return before;
    }

    if (beforeSignals.pageBlankish) {
      log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'blank-state-retry-before-click' });
      runner.waitMs(1500);
      const retried = runner.readRoomSyncState(targetId, room);
      lastState = retried;
      const retriedSignals = roomSignals(retried);
      log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'retry-before-click-state', state: retried, signals: retriedSignals });
      if (retried.activeRoomConfirmed) return retried;
      if (!retriedSignals.pageBlankish && (retriedSignals.roomMentioned || retriedSignals.buttonSeen || retriedSignals.outputControlsSeen)) {
        return {
          ...retried,
          activeRoomConfirmed: true,
          softConfirmed: true,
          confirmSignals: [...new Set([...(retried.confirmSignals || []), 'retry-visible-signals'])],
        };
      }
    }

    const clickResult = runner.clickRoomActivate(targetId, room);
    lastClickResult = clickResult;
    log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'click-activate', clickResult });
    runner.waitMs(1500);

    const after = runner.readRoomSyncState(targetId, room);
    lastState = after;
    const afterSignals = roomSignals(after);
    log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'post-click-state', state: after, signals: afterSignals });

    if (after.activeRoomConfirmed) {
      return after;
    }

    if (isSoftConfirmed(after, clickResult)) {
      log({
        ok: true,
        phase: 'active-room-sync',
        attempt,
        room,
        event: 'soft-confirmed',
        reason: 'activate click landed and target room signals remain visible; defer final truth to CLI verification',
        confirmSignals: after.confirmSignals,
      });
      return {
        ...after,
        activeRoomConfirmed: true,
        softConfirmed: true,
      };
    }

    if (afterSignals.pageBlankish && attempt < maxAttempts) {
      log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'blank-state-retry-after-click' });
      runner.waitMs(2000);
    }
  }

  throw new SkillError(
    'active-room-sync',
    'WEB_ACTIVE_ROOM_SYNC_FAILED',
    'Failed to confirm that the Sonos Web UI active output switched to the target room.',
    {
      room,
      roomContext: lastState || runner.readRoomSyncState(targetId, room),
      lastClickResult,
    }
  );
}

function setSearchInputValue(runner, targetId, label, query, log) {
  const focusResult = runner.evaluate(
    targetId,
    `async () => {
      const requested = ${JSON.stringify(label || '')};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const selector = [
        'input',
        'textarea',
        '[contenteditable="true"]',
        '[role="combobox"]',
        '[role="searchbox"]',
        '[aria-label*="搜索"]',
        '[placeholder*="搜索"]',
        'input[type="search"]',
        '[data-testid*="search"]',
        '[class*="search"] input',
        '[class*="Search"] input'
      ].join(',');
      const summarize = (elements) => elements.slice(0, 12).map((el) => ({
        tag: el.tagName,
        type: 'type' in el ? (el.type || '') : '',
        role: el.getAttribute('role') || '',
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        className: String(el.className || '').slice(0, 120),
        text: (el.textContent || '').trim().slice(0, 80),
        contenteditable: el.getAttribute('contenteditable') || '',
      }));
      const matchesRequested = (el) => {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const role = (el.getAttribute('role') || '').trim();
        const className = String(el.className || '');
        const type = ('type' in el ? String(el.type || '') : '').trim();
        const text = (el.textContent || '').trim();
        if (requested && (aria === requested || placeholder === requested)) return true;
        if (role === 'searchbox' || role === 'combobox') return true;
        if (type === 'search') return true;
        if (placeholder.includes('搜索') || aria.includes('搜索')) return true;
        if (/search/i.test(className) || /搜索/.test(text)) return true;
        return false;
      };

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidates = [...document.querySelectorAll(selector)];
        const target = candidates.find(matchesRequested) || document.querySelector('input[type="search"]');
        if (target) {
          target.focus();
          if ('click' in target) target.click();
          if ('value' in target) target.value = '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          return {
            ok: true,
            attempt,
            tag: target.tagName,
            placeholder: target.getAttribute('placeholder') || '',
            aria: target.getAttribute('aria-label') || '',
            role: target.getAttribute('role') || '',
            type: 'type' in target ? (target.type || '') : '',
          };
        }
        await sleep(350);
      }

      const candidates = [...document.querySelectorAll(selector)];
      return {
        ok: false,
        reason: 'search-input-not-found',
        diagnostics: {
          location: String(location.href || ''),
          title: String(document.title || ''),
          bodyPreview: (document.body?.innerText || '').trim().slice(0, 1200),
          candidateCount: candidates.length,
          candidates: summarize(candidates),
          iframeCount: document.querySelectorAll('iframe').length,
        },
      };
    }`
  );
  const focused = focusResult?.result || focusResult;
  if (!focused?.ok) {
    log({ ok: false, phase: 'search', event: 'input-focus-miss', detail: focused });
    throw new SkillError('search', 'SEARCH_INPUT_FOCUS_FAILED', 'Failed to focus the Sonos search input.', {
      diagnostic: {
        ...diagnose(runner, targetId, 'search', 'focus search input before paste', focused?.reason || 'not found'),
        focusProbe: focused,
      },
    });
  }

  const writeResult = runner.evaluate(
    targetId,
    `async () => {
      try {
        await navigator.clipboard.writeText(${JSON.stringify(query)});
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
      }
    }`
  );
  const wrote = writeResult?.result || writeResult;
  if (!wrote?.ok) {
    throw new SkillError('search', 'SEARCH_CLIPBOARD_WRITE_FAILED', 'Clipboard write failed for the Sonos search input path.', {
      diagnostic: diagnose(runner, targetId, 'search', 'clipboard.writeText', wrote?.reason || 'clipboard failure'),
    });
  }

  runner.press(targetId, 'Meta+V');
  log({ ok: true, phase: 'search', event: 'input-applied', input: focused });
}

function search(runner, targetId, query, log) {
  let lastSnapshot = null;
  let lastContext = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      ensureSearchReady(runner, targetId, log);
      log({ ok: true, phase: 'search', event: 'retry-after-dead-page', attempt });
    }

    const initialSnapshot = runner.snapshot(targetId, 220);
    const input = findSearchInput(initialSnapshot.nodes);
    setSearchInputValue(runner, targetId, input?.name || '搜索', query, log);
    for (let pollAttempt = 1; pollAttempt <= 5; pollAttempt += 1) {
      runner.waitMs(1000);
      const after = runner.snapshot(targetId, 320);
      const pageSearchState = inspectSearchSurface(runner, targetId);
      const context = readContentContext(runner, targetId);
      const bodyText = after.nodes.map((node) => nodeText(node)).join(' ');
      const pageKind = context?.pageKind || 'UNKNOWN';
      const hasSearchHistory = pageSearchState.hasSearchHistory || bodyText.includes('搜索记录');
      const hasResults =
        pageSearchState.hasPlayableButton ||
        pageSearchState.hasRenderedResults ||
        after.nodes.some((node) => /^播放/.test(String(node.name || '')) && /(网易云音乐|QQ音乐)/.test(nodeText(node)));
      const contextSuccess =
        pageKind === 'SEARCH_RESULTS_MIXED' ||
        pageKind === 'SEARCH_RESULTS_PLAYLISTS' ||
        pageKind === 'SEARCH_HISTORY';
      const successSignals = {
        hasRenderedResults: pageSearchState.hasRenderedResults,
        hasPlayableButton: pageSearchState.hasPlayableButton,
        pageKind,
      };

      lastSnapshot = after;
      lastContext = context;

      log({
        ok: true,
        phase: 'search',
        event: 'poll',
        attempt,
        pollAttempt,
        waitedMs: pollAttempt * 1000,
        hasSearchHistory,
        hasResults,
        context: summarizePageContext(context),
        successSignals,
      });

      if (hasResults || hasSearchHistory || contextSuccess) {
        return after;
      }
    }
  }

  throw new SkillError('search', 'SEARCH_DEAD_PAGE', 'Search input changed but Sonos did not render a live search page.', {
    diagnostic: diagnose(runner, targetId, 'search', 'focus + clipboard + paste', 'search page stayed dead'),
    snapshotNodeCount: lastSnapshot?.nodes?.length || 0,
    pageContext: summarizePageContext(lastContext),
  });
}

function extractRealSearchResults(runner, targetId) {
  const context = readContentContext(runner, targetId);
  const controls = Array.isArray(context?.controls) ? context.controls : [];
  const resultControls = controls.filter((entry) => ['search-results', 'full-results'].includes(entry.zone));

  let inheritedService = '';
  const normalizedControls = resultControls.map((entry) => {
    const explicitService = entry.service || '';
    if (entry.controlRole === 'expand' && explicitService) {
      inheritedService = explicitService;
      return { ...entry, inheritedService };
    }
    const next = explicitService || inheritedService || '';
    return { ...entry, inheritedService: next };
  });

  const candidates = buildContainerCandidates(normalizedControls)
    .filter((entry) => entry.openDetailTarget || entry.directPlayTarget || entry.expandTarget)
    .map((entry) => ({
      index: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.expandTarget?.index,
      text: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.expandTarget?.clickLabel || '',
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      service: entry.service || entry.inheritedService || '',
      zone: entry.zone,
      openDetailTarget: entry.openDetailTarget,
      directPlayTarget: entry.directPlayTarget,
      expandTarget: entry.expandTarget,
      type: entry.type,
      sectionKind: entry.sectionKind,
    }));
  return {
    pageKind: context?.pageKind || 'UNKNOWN',
    detail: context?.detail || null,
    sections: context?.sections || [],
    candidates,
    sample: normalizedControls.slice(0, 20),
  };
}

function listViewAllCandidates(runner, targetId) {
  const context = readContentContext(runner, targetId);
  const sections = Array.isArray(context?.sections) ? context.sections : [];
  const candidates = sections.flatMap((section) =>
    (section.viewAllButtons || []).map((button) => ({
      index: button.index,
      text: button.text,
      scope: section.textSample || '',
      section: section.heading || '',
      service: '',
      zone: button.zone || 'search-results',
      sectionKind: section.sectionKind || 'unknown',
      sectionKindSource: section.sectionKindSource || 'unknown',
      sectionTypeCounts: section.typeCounts || {},
    }))
  );
  return {
    pageKind: context?.pageKind || 'UNKNOWN',
    candidates: candidates.map((entry) => ({ ...entry, sectionKind: entry.sectionKind || inferSectionKind(entry.section) })),
    sectionKinds: sections.map((entry) => entry.sectionKind).filter(Boolean),
  };
}

function summarizePageContext(context) {
  if (!context) return {};
  return {
    pageKind: context.pageKind,
    resultsPresent: context.resultsPresent,
    searchHistory: context.searchHistory,
    searchShellDirty: context.searchShellDirty,
    playlistOnly: context.playlistOnly,
    typeLabelCounts: context.typeLabelCounts,
    viewAllCount: context.viewAllCount,
    serviceLabels: context.serviceLabels,
    candidateCount: context.candidateCount,
    availableSections: (context.sections || []).map((entry) => entry.sectionKind).filter(Boolean),
  };
}

function getSectionInfo(context, kind) {
  const sections = Array.isArray(context?.sections) ? context.sections : [];
  const matches = sections.filter((section) => section.sectionKind === kind);
  const viewAllButtons = matches.flatMap((section) => section.viewAllButtons || []);
  return {
    matches,
    viewAllButtons,
    hasSection: matches.length > 0,
    hasViewAll: viewAllButtons.length > 0,
  };
}

function buildViewAllTokenSet(queryPlan, query) {
  return dedupeValues([
    ...(Array.isArray(queryPlan?.intentProfile?.viewAllTokens) ? queryPlan.intentProfile.viewAllTokens : []),
    queryPlan?.originalIntent,
    queryPlan?.intent,
    query,
  ]
    .flatMap((value) => tokenizeForMatching(value))
    .filter((token) => token.length >= 2));
}

function dedupeValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function scoreViewAllCandidate({ entry, queryPlan, query, sectionHint }) {
  const haystack = normalizeText([entry.text, entry.scope, entry.section, entry.service].join(' '));
  const intentTokens = buildViewAllTokenSet(queryPlan, query);
  const queryTokens = tokenizeForMatching(query);
  const requestKind = queryPlan?.intentProfile?.requestKind || queryPlan.requestKind;
  const sectionHintTokens = tokenizeForMatching(sectionHint);

  let score = 0;
  for (const token of intentTokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 6;
  }
  for (const token of queryTokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 4;
  }
  for (const token of sectionHintTokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 8;
  }

  if (requestKind === 'playlist' && /播放列表|歌单|精选/.test(haystack)) score += 10;
  if (requestKind === 'artist' && /艺术家|艺人|歌手|热门/.test(haystack)) score += 10;
  if (requestKind === 'album' && /专辑|album/.test(haystack)) score += 10;
  if (requestKind === 'song' && /歌曲|单曲|song|track/.test(haystack)) score += 10;
  if (requestKind && entry.sectionKind && entry.sectionKind !== 'unknown') {
    if (entry.sectionKind === requestKind) score += 12;
    if (entry.sectionKind !== requestKind) score -= 6;
  }

  if (/网易云音乐/.test(entry.service || '') || /网易云音乐/.test(entry.scope || '')) score += 5;
  if (/QQ音乐/.test(entry.service || '') || /QQ音乐/.test(entry.scope || '')) score += 3;
  if (BLOCKED_RESULT_PATTERNS.test(entry.scope || '')) score -= 20;
  if (ROOM_CONTROL_PATTERNS.test(entry.scope || '')) score -= 20;

  return score;
}

function clickViewAllIfPresent(runner, targetId, { queryPlan, query, sectionHint, log }) {
  const listed = listViewAllCandidates(runner, targetId);
  const strategy = queryPlan?.strategy || queryPlan?.intentProfile?.strategy || 'default';
  const requiredSectionKind = strategy === 'playlist-first' ? 'playlist' : null;
  const scopedCandidates = (Array.isArray(listed?.candidates) ? listed.candidates : [])
    .filter((entry) => !BLOCKED_ZONES.has(entry.zone));
  const candidates = requiredSectionKind
    ? scopedCandidates.filter((entry) => entry.sectionKind === requiredSectionKind)
    : scopedCandidates;
  if (!candidates.length) {
    log({
      ok: true,
      phase: 'result-expander',
      expanded: false,
      reason: requiredSectionKind ? 'required-section-view-all-not-found' : 'view-all-not-found',
      strategy,
      requiredSectionKind,
      availableSections: listed?.sectionKinds || scopedCandidates.map((entry) => entry.sectionKind).filter(Boolean),
    });
    return {
      expanded: false,
      clicked: { ok: false, reason: requiredSectionKind ? 'required-section-view-all-not-found' : 'view-all-not-found' },
      rankedCandidates: [],
      requiredSectionKind,
      availableSections: listed?.sectionKinds || [],
    };
  }

  const rankedCandidates = candidates
    .map((entry) => ({ ...entry, score: scoreViewAllCandidate({ entry, queryPlan, query, sectionHint }) }))
    .sort((left, right) => right.score - left.score);
  const selected = rankedCandidates[0];
  if (!selected || (rankedCandidates.length > 1 && selected.score < MIN_VIEW_ALL_SELECTION_SCORE)) {
    log({
      ok: true,
      phase: 'result-expander',
      expanded: false,
      reason: 'view-all-score-too-low',
      strategy,
      requiredSectionKind,
      selected,
      rankedCandidates: rankedCandidates.slice(0, 3),
    });
    return {
      expanded: false,
      clicked: { ok: false, reason: 'view-all-score-too-low' },
      rankedCandidates,
      selected,
      requiredSectionKind,
      availableSections: listed?.sectionKinds || [],
    };
  }

  const clickResult = runner.evaluate(
    targetId,
    `() => {
      const targetIndex = ${JSON.stringify(selected.index)};
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const interactive = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el, index) => ({ el, index, text: textOf(el) }));
      const target = interactive.find((entry) => entry.index === targetIndex && /查看全部|查看所有|查看更多/.test(entry.text));
      if (!target) return { ok: false, reason: 'target-view-all-not-found', targetIndex };
      target.el.click();
      return { ok: true, label: target.text, index: target.index };
    }`
  );
  const clicked = clickResult?.result || clickResult;
  log({
    ok: true,
    phase: 'result-expander',
    clicked,
    strategy,
    requiredSectionKind,
    viewAllSection: selected?.sectionKind || null,
    rankedCandidates: rankedCandidates.slice(0, 3),
    selectedByIntent: selected,
  });
  if (!clicked?.ok) return { expanded: false, clicked, rankedCandidates };

  runner.waitMs(1500);
  return { expanded: true, clicked, rankedCandidates, selected, requiredSectionKind, availableSections: listed?.sectionKinds || [] };
}

function extractCatalog(runner, targetId, { sectionKind, pageKind } = {}) {
  const context = readContentContext(runner, targetId);
  const controls = Array.isArray(context?.controls) ? context.controls : [];
  const zones = pageKind === 'PLAYLIST_DETAIL_READY'
    ? ['detail-content']
    : ['search-results', 'full-results'];
  const scopedControls = controls.filter((entry) => zones.includes(entry.zone));
  return {
    pageKind: context?.pageKind || 'UNKNOWN',
    detail: context?.detail || null,
    controls: buildContainerCandidates(scopedControls)
      .filter((entry) => entry.title)
      .filter((entry) => !isBlockedResultNoise(entry))
      .filter((entry) => !isRoomControlNoise(entry))
      .filter((entry) => !sectionKind || entry.sectionKind === sectionKind)
      .map((entry) => ({
        ...entry,
        clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.expandTarget?.clickLabel || entry.title,
        targetIndex: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.expandTarget?.index,
        isPlayable: Boolean(entry.directPlayTarget),
        isViewAll: Boolean(entry.expandTarget),
      })),
    sample: controls.slice(0, 30),
  };
}

function inferCandidateType(entry) {
  const haystack = normalizeText([entry.sectionLabel, entry.scopeText, entry.text].filter(Boolean).join(' '));
  if (/播放列表|歌单|playlist|精选|合集/.test(haystack)) return 'playlist';
  if (/专辑|album/.test(haystack)) return 'album';
  if (/艺术家|艺人|歌手|artist/.test(haystack)) return 'artist';
  if (/歌曲|单曲|track|song/.test(haystack)) return 'song';
  return 'generic';
}

function inferSectionKind(value) {
  const normalized = normalizeText(value);
  if (/播放列表|歌单|playlist|精选|合集/.test(normalized)) return 'playlist';
  if (/专辑|album/.test(normalized)) return 'album';
  if (/艺术家|艺人|歌手|artist/.test(normalized)) return 'artist';
  if (/歌曲|单曲|track|song/.test(normalized)) return 'song';
  return 'unknown';
}

function inferInteractionMode(entry, requestKind) {
  if (entry.openDetailTarget?.clickLabel) return 'open-detail';
  if (entry.expandTarget?.clickLabel) return 'expand';
  if (entry.directPlayTarget?.clickLabel && (entry.type === 'song' || requestKind === 'song')) return 'direct-play';
  if (entry.directPlayTarget?.clickLabel) return 'direct-play';
  return 'unknown';
}

function shouldAllowDirectPlay(entry, requestKind, strategy = 'default') {
  if (!entry) return false;
  if (strategy === 'playlist-first') return false;
  if (entry.interactionMode === 'direct-play') return true;
  if (entry.type === 'song') return true;
  if (requestKind === 'song') return true;
  return false;
}

function buildResultGroups(searchResults, catalog, requestKind) {
  const directCandidates = (Array.isArray(searchResults?.candidates) ? searchResults.candidates : [])
    .map((entry) => ({
      title: deriveCandidateTitle({
        clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.text,
        scopeText: entry.scopeText,
        sectionLabel: entry.sectionLabel || entry.scopeText,
      }),
      clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.text,
      targetIndex: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.index,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel || entry.scopeText,
      service: entry.service,
      type: entry.type || inferCandidateType({ ...entry, sectionLabel: entry.sectionLabel || entry.scopeText }),
      zone: entry.zone,
      sectionKind: entry.sectionKind || entry.containerSectionKind || inferSectionKind(entry.sectionLabel || entry.scopeText),
      openDetailTarget: entry.openDetailTarget || null,
      directPlayTarget: entry.directPlayTarget || (entry.index != null ? { index: entry.index, clickLabel: entry.text, controlRole: 'play' } : null),
      expandTarget: entry.expandTarget || null,
      source: 'search-results',
    }))
    .map((entry) => ({ ...entry, interactionMode: inferInteractionMode(entry, requestKind) }));
  const catalogCandidates = (Array.isArray(catalog?.controls) ? catalog.controls : [])
    .filter((entry) => entry.openDetailTarget || entry.directPlayTarget || entry.expandTarget)
    .filter((entry) => !isRoomControlNoise(entry))
    .filter((entry) => !BLOCKED_ZONES.has(entry.zone))
    .map((entry) => ({
      title: deriveCandidateTitle({
        clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.clickLabel,
        scopeText: entry.scopeText,
        sectionLabel: entry.sectionLabel,
      }),
      clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.clickLabel,
      targetIndex: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.targetIndex,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      service: entry.service,
      type: entry.type || inferCandidateType(entry),
      zone: entry.zone,
      sectionKind: entry.sectionKind || entry.containerSectionKind || inferSectionKind(entry.sectionLabel || entry.scopeText),
      openDetailTarget: entry.openDetailTarget || null,
      directPlayTarget: entry.directPlayTarget || null,
      expandTarget: entry.expandTarget || null,
      source: 'catalog',
    }))
    .map((entry) => ({ ...entry, interactionMode: inferInteractionMode(entry, requestKind) }));
  const merged = [...directCandidates, ...catalogCandidates]
    .filter((entry) => entry.title)
    .filter((entry) => !isBlockedResultNoise(entry))
    .filter((entry) => isAllowedMusicSource(entry))
    .filter((entry) => !BLOCKED_ZONES.has(entry.zone));

  const deduped = [];
  const seen = new Set();
  for (const entry of merged) {
    const key = normalizeText(`${entry.type}|${entry.title}|${entry.clickLabel}`);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped.reduce((groups, entry) => {
    const type = entry.type === 'generic' && entry.sectionKind === 'playlist' ? 'playlist' : entry.type;
    groups[type] = groups[type] || [];
    groups[type].push({ ...entry, type });
    return groups;
  }, {});
}

function resolveAllowedTypes(queryPlan) {
  const allowed = Array.isArray(queryPlan?.allowedTypes) && queryPlan.allowedTypes.length
    ? queryPlan.allowedTypes
    : Array.isArray(queryPlan?.intentProfile?.allowedTypes) ? queryPlan.intentProfile.allowedTypes : [];
  return [...new Set((allowed || []).filter(Boolean))];
}

function isSearchQueryApplied(context, query) {
  const normalizedQuery = normalizeText(query || '');
  if (!normalizedQuery) return false;
  const bodyPreview = normalizeText(context?.bodyPreview || '');
  return Boolean(
    normalizeText(context?.pageKind || '').startsWith('search_results') ||
    bodyPreview.includes(normalizedQuery) ||
    context?.resultsPresent
  );
}

function isResultCluster(context, searchResults, catalog) {
  const searchCandidateCount = Array.isArray(searchResults?.candidates) ? searchResults.candidates.length : 0;
  const catalogCount = Array.isArray(catalog?.controls) ? catalog.controls.length : 0;
  const total = searchCandidateCount + catalogCount;
  return Boolean(
    context?.resultsPresent &&
    ['SEARCH_RESULTS_MIXED', 'SEARCH_RESULTS_PLAYLISTS'].includes(context?.pageKind) &&
    total >= 2
  );
}

function isRecentlyPlayedCandidate(candidate, playbackHistory = [], query = '') {
  const historyPenalty = scoreHistoryPenalty({
    candidate,
    history: playbackHistory,
    now: new Date().toISOString(),
    query,
  });
  return Boolean(historyPenalty.total < 0);
}

function looksLikeStructuralResultItem(entry) {
  if (!entry) return false;
  const haystack = normalizeWhitespace([
    entry.title,
    entry.clickLabel,
    entry.scopeText,
    entry.sectionLabel,
    entry.service,
  ].filter(Boolean).join(' '));
  if (!haystack) return false;
  if (TITLE_BLOCKLIST.test(haystack) || BLOCKED_RESULT_PATTERNS.test(haystack) || BLOCKED_SOURCE_PATTERNS.test(haystack)) return false;
  if (isRoomControlNoise(entry) || isBlockedResultNoise(entry)) return false;
  if (!isAllowedMusicSource(entry)) return false;
  if (VIEW_ALL_LABELS.test(entry.title || '') || VIEW_ALL_LABELS.test(entry.clickLabel || '')) return false;

  const hasPlayableControl = /^播放/.test(normalizeWhitespace(entry.clickLabel || '')) || entry.interactionMode === 'direct-play';
  const hasMediaText = hasMediaIdentitySignal(haystack);
  const typed = ['playlist', 'album', 'artist', 'song'].includes(entry.type) || ['playlist', 'album', 'artist', 'song'].includes(entry.sectionKind);
  return Boolean(hasPlayableControl || hasMediaText || typed);
}

function findClusterStartIndex(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      ...entry,
      targetIndex: Number.isFinite(entry?.targetIndex) ? entry.targetIndex : null,
      clickLabel: normalizeWhitespace(entry?.clickLabel || ''),
      title: normalizeWhitespace(entry?.title || ''),
    }))
    .filter((entry) => entry.targetIndex != null)
    .sort((a, b) => a.targetIndex - b.targetIndex);

  const viewAll = normalized.find((entry) => VIEW_ALL_LABELS.test(entry.clickLabel) || VIEW_ALL_LABELS.test(entry.title));
  if (viewAll) return viewAll.targetIndex + 1;

  const firstPlayableMedia = normalized.find((entry) => looksLikeStructuralResultItem(entry));
  return firstPlayableMedia?.targetIndex ?? null;
}

function collectClusterCandidates({ searchResults, catalog, playbackHistory = [], query }) {
  const merged = [];
  const pushCandidate = (entry, source) => {
    if (!entry) return;
    const title = normalizeWhitespace(entry.title || entry.clickLabel || '');
    const clickLabel = normalizeWhitespace(entry.clickLabel || entry.title || '');
     const sourceText = normalizeWhitespace([entry.title, entry.clickLabel, entry.scopeText, entry.sectionLabel, entry.service].filter(Boolean).join(' '));
    const targetIndex = Number.isFinite(entry.targetIndex)
      ? entry.targetIndex
      : Number.isFinite(entry.openDetailTarget?.index)
        ? entry.openDetailTarget.index
        : Number.isFinite(entry.directPlayTarget?.index)
          ? entry.directPlayTarget.index
          : Number.isFinite(entry.expandTarget?.index)
            ? entry.expandTarget.index
            : null;
    if (!title || targetIndex == null) return;
    if (BLOCKED_SOURCE_PATTERNS.test(sourceText)) return;
    if (!isAllowedMusicSource(entry)) return;
    const normalizedTitle = normalizeText(title);
    if (!normalizedTitle) return;
    merged.push({
      ...entry,
      title,
      clickLabel,
      targetIndex,
      source,
      recentlyPlayed: isRecentlyPlayedCandidate({ ...entry, title }, playbackHistory, query),
    });
  };

  for (const entry of Array.isArray(searchResults?.candidates) ? searchResults.candidates : []) {
    pushCandidate({
      ...entry,
      title: deriveCandidateTitle({
        clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.text,
        scopeText: entry.scopeText,
        sectionLabel: entry.sectionLabel || entry.scopeText,
      }),
      clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.text,
      targetIndex: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.index,
      type: entry.type || inferCandidateType({ ...entry, sectionLabel: entry.sectionLabel || entry.scopeText }),
      interactionMode: inferInteractionMode(entry, 'generic'),
    }, 'search-results');
  }

  for (const entry of Array.isArray(catalog?.controls) ? catalog.controls : []) {
    pushCandidate({
      ...entry,
      title: normalizeWhitespace(entry.title || entry.clickLabel || ''),
      clickLabel: entry.openDetailTarget?.clickLabel || entry.directPlayTarget?.clickLabel || entry.clickLabel,
      targetIndex: entry.openDetailTarget?.index ?? entry.directPlayTarget?.index ?? entry.targetIndex,
      type: entry.type || inferCandidateType(entry),
      interactionMode: inferInteractionMode(entry, 'generic'),
    }, 'catalog');
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of merged.sort((a, b) => (a.targetIndex ?? 99999) - (b.targetIndex ?? 99999))) {
    const key = `${normalizeText(entry.title)}|${entry.targetIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  const clusterStartIndex = findClusterStartIndex(deduped);
  const structurallyScoped = deduped.filter((entry) => {
    if (!looksLikeStructuralResultItem(entry)) return false;
    if (clusterStartIndex != null && Number.isFinite(entry.targetIndex) && entry.targetIndex < clusterStartIndex) return false;
    return true;
  });

  const fresh = structurallyScoped.filter((entry) => !entry.recentlyPlayed);
  const rotationOrdered = fresh.length
    ? [...fresh, ...structurallyScoped.filter((entry) => entry.recentlyPlayed)]
    : structurallyScoped;
  return {
    ordered: rotationOrdered,
    selected: rotationOrdered[0] || null,
    debug: {
      clusterStartIndex,
      rawCount: deduped.length,
      structuredCount: structurallyScoped.length,
      freshCount: fresh.length,
    },
  };
}

function isExactSongMatch(entry, query) {
  if (!entry) return false;
  const normalizedQuery = normalizeText(query || '');
  if (!normalizedQuery) return false;
  const title = normalizeText(entry.title || '');
  const clickLabel = normalizeText(String(entry.clickLabel || '').replace(/^播放/, ''));
  const scopeText = normalizeText(entry.scopeText || '');
  const exactTitle = title === normalizedQuery || clickLabel === normalizedQuery;
  const tightScoped = scopeText.includes(normalizedQuery) && normalizedQuery.length >= 2;
  return Boolean((entry.type === 'song' || entry.sectionKind === 'song') && (exactTitle || tightScoped));
}

function candidateTypePriority(entry) {
  const type = entry?.type || entry?.sectionKind || 'unknown';
  if (type === 'playlist') return 4;
  if (type === 'album') return 3;
  if (type === 'artist') return 2;
  if (type === 'song') return 1;
  return 0;
}

function scoreCandidateByIntent(entry, query, exactSongMode) {
  const haystack = normalizeText([
    entry?.title,
    entry?.clickLabel,
    entry?.scopeText,
    entry?.sectionLabel,
    entry?.service,
  ].filter(Boolean).join(' '));
  const normalizedQuery = normalizeText(query || '');
  const title = normalizeText(entry?.title || '');
  const scopeText = normalizeText(entry?.scopeText || '');
  const type = entry?.type || entry?.sectionKind || 'unknown';

  let score = 0;
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 20;
  if (normalizedQuery && title === normalizedQuery) score += 50;
  if (normalizedQuery && scopeText.includes(normalizedQuery)) score += 8;

  if (exactSongMode) {
    if (type === 'song') score += 40;
    if (type === 'playlist') score -= 20;
    if (type === 'album') score -= 10;
    if (type === 'artist') score -= 5;
  } else {
    if (type === 'playlist') score += 40;
    if (type === 'album') score += 10;
    if (type === 'artist') score += 4;
    if (type === 'song') score -= 15;
  }

  score += candidateTypePriority(entry);
  if (entry?.recentlyPlayed) score -= 5;
  return score;
}

function selectBestCandidate({ queryPlan, query, searchResults, catalog, playbackHistory, log }) {
  const orderedPool = collectClusterCandidates({ searchResults, catalog, playbackHistory, query });
  const ranked = Array.isArray(orderedPool?.ordered) ? orderedPool.ordered : [];
  const exactSongCandidates = ranked.filter((entry) => isExactSongMatch(entry, query));
  const exactSongMode = exactSongCandidates.length > 0;
  const rescored = ranked
    .map((entry, index) => ({
      ...entry,
      intentScore: scoreCandidateByIntent(entry, query, exactSongMode),
      originalOrder: index,
    }))
    .sort((a, b) => {
      if (b.intentScore !== a.intentScore) return b.intentScore - a.intentScore;
      return a.originalOrder - b.originalOrder;
    });
  const selected = rescored[0] || null;

  log({
    ok: true,
    phase: 'candidate-order',
    query,
    strategy: exactSongMode ? 'exact-song-first' : 'fallback-playlist-first',
    allowedTypes: exactSongMode ? ['song'] : ['playlist', 'album', 'artist', 'song'],
    selected,
    rankedTop: rescored.slice(0, 5).map((entry) => ({
      title: entry.title,
      type: entry.type,
      sectionKind: entry.sectionKind,
      targetIndex: entry.targetIndex,
      intentScore: entry.intentScore,
      scopeText: entry.scopeText,
    })),
    debug: {
      mode: exactSongMode ? 'exact-song-first' : 'fallback-playlist-first',
      clusterDebug: orderedPool?.debug || null,
      exactSongCandidates: exactSongCandidates.map((entry) => ({
        title: entry.title,
        type: entry.type,
        targetIndex: entry.targetIndex ?? null,
      })),
      recentlyPlayedSkipped: ranked.filter((entry) => entry?.recentlyPlayed).map((entry) => ({
        title: entry.title,
        targetIndex: entry.targetIndex ?? null,
      })),
    },
  });

  return {
    selected,
    ranked: rescored,
    debug: {
      mode: exactSongMode ? 'exact-song-first' : 'fallback-playlist-first',
      clusterDebug: orderedPool?.debug || null,
      exactSongMode,
    },
  };
}

function resolveClickTarget(resultEntry, mode = 'open-detail') {
  if (!resultEntry) return null;
  if (mode === 'open-detail') return resultEntry.openDetailTarget || null;
  if (mode === 'expand') return resultEntry.expandTarget || null;
  if (mode === 'direct-play') return resultEntry.directPlayTarget || null;
  return resultEntry.openDetailTarget || resultEntry.expandTarget || resultEntry.directPlayTarget || null;
}

function performCandidateClick(runner, targetId, resultEntry, { mode = 'open-detail' } = {}) {
  const target = resolveClickTarget(resultEntry, mode);
  const ariaLabel = String(target?.clickLabel || resultEntry?.clickLabel || resultEntry?.text || '').trim();
  const targetIndex = target?.index;
  if (!Number.isFinite(targetIndex) && !ariaLabel) {
    return {
      ariaLabel: '',
      targetIndex: null,
      clickedControlRole: target?.controlRole || mode,
      requestedMode: mode,
      indexResult: { ok: false, reason: 'no-click-target' },
      nativeClick: { ok: false, reason: 'no-click-target' },
    };
  }
  const indexClick = Number.isFinite(targetIndex)
    ? runner.evaluate(
      targetId,
      `() => {
        const targetIndex = ${JSON.stringify(targetIndex)};
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();
        const interactive = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .filter(visible)
          .map((el, index) => ({ el, index, text: textOf(el) }));
        const target = interactive.find((entry) => entry.index === targetIndex);
        if (!target) return { ok: false, reason: 'target-index-not-found', targetIndex };
        target.el.click();
        return { ok: true, label: target.text, index: target.index };
      }`
    )
    : null;
  const indexResult = indexClick?.result || indexClick;
  const nativeClick = indexResult?.ok || !ariaLabel
    ? indexClick
    : runner.evaluate(
      targetId,
      `() => {
        const label = ${JSON.stringify(ariaLabel)};
        const button = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .find((el) => ((el.getAttribute('aria-label') || el.textContent || '').trim()) === label);
        if (!button) return { ok: false, reason: 'native-button-not-found', label };
        button.click();
        return { ok: true, label };
      }`
    );
  return {
    ariaLabel,
    targetIndex,
    clickedControlRole: target?.controlRole || mode,
    requestedMode: mode,
    indexResult,
    nativeClick: nativeClick?.result || nativeClick,
  };
}

function readDetailSignals(runner, targetId) {
  const context = readContentContext(runner, targetId);
  const detail = context?.detail || null;
  return {
    pageKind: context?.pageKind || 'UNKNOWN',
    isDetail: ['PLAYLIST_DETAIL_READY', 'CONTENT_DETAIL_READY'].includes(context?.pageKind) && !!detail,
    score: detail ? 5 : 0,
    headingText: detail?.playlistTitle || '',
    containerTextSample: '',
    service: detail?.service || '',
    typeHint: Boolean(detail?.playlistTitle),
    hasMoreOptions: Boolean(detail?.actionArea?.moreOptionsIndex != null),
    moreButtonZone: detail?.actionArea?.moreOptionsIndex != null ? 'detail-content' : null,
    playButtonLabel: detail?.actionArea?.playLabel || null,
    detailContainerIndex: detail?.actionArea?.index ?? null,
    topLevelMoreOptionsIndex: detail?.actionArea?.moreOptionsIndex ?? null,
    aggregationContainers: context?.aggregationContainers || [],
    detail,
  };
}

function deriveSelectedContent({ resultEntry, ariaLabel, detailSignals }) {
  return normalizeWhitespace(
    resultEntry.title ||
    detailSignals?.headingText ||
    String(ariaLabel || '').replace(/^播放/, '')
  );
}

function attemptOpenDetail(runner, targetId, resultEntry, log, { retries = 1 } = {}) {
  const beforeState = runner.readPageState(targetId);
  let lastClick = null;
  let lastSignals = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const click = performCandidateClick(runner, targetId, resultEntry, { mode: 'open-detail' });
    const clickOk = click?.indexResult?.ok || click?.nativeClick?.ok;
    lastClick = click;
    runner.waitMs(1200);
    const detailSignals = readDetailSignals(runner, targetId);
    lastSignals = detailSignals;

    if (clickOk && detailSignals?.isDetail && detailSignals?.hasMoreOptions) {
      const selectedContent = deriveSelectedContent({ resultEntry, ariaLabel: click.ariaLabel, detailSignals });
      log({
        ok: true,
        phase: 'detail-page',
        attempt,
        selectedContent,
        clickedControlRole: click.clickedControlRole,
        pageKindBefore: beforeState?.pageKind || null,
        pageKindAfter: detailSignals?.pageKind || null,
        clickResult: click?.nativeClick || click?.indexResult,
        detailSignals,
      });
      return { ok: true, selectedContent, detailSignals, click };
    }

    log({
      ok: true,
      phase: 'detail-page-attempt',
      status: 'failed',
      attempt,
      selectedResult: click.ariaLabel,
      clickedControlRole: click.clickedControlRole,
      pageKindBefore: beforeState?.pageKind || null,
      pageKindAfter: detailSignals?.pageKind || null,
      clickResult: click?.nativeClick || click?.indexResult || null,
      detailSignals,
    });
    runner.waitMs(500);
  }

  return {
    ok: false,
    reason: !lastClick?.indexResult?.ok && !lastClick?.nativeClick?.ok
      ? 'candidate-click-failed'
      : lastClick?.targetIndex == null ? 'open-detail-target-missing' : 'detail-signals-missing',
    click: lastClick,
    detailSignals: lastSignals,
  };
}

function attemptDirectPlay(runner, targetId, resultEntry, log) {
  const beforeState = runner.readPageState(targetId);
  const click = performCandidateClick(runner, targetId, resultEntry, { mode: 'direct-play' });
  const clickOk = click?.indexResult?.ok || click?.nativeClick?.ok;
  runner.waitMs(1200);
  const detailSignals = readDetailSignals(runner, targetId);
  if (!clickOk) {
    log({
      ok: true,
      phase: 'direct-play-attempt',
      status: 'failed',
      selectedResult: click.ariaLabel,
      clickedControlRole: click.clickedControlRole,
      pageKindBefore: beforeState?.pageKind || null,
      pageKindAfter: detailSignals?.pageKind || null,
      clickResult: click?.nativeClick || click?.indexResult || null,
      detailSignals,
    });
    return { ok: false, reason: 'candidate-click-failed', click, detailSignals };
  }

  const selectedContent = deriveSelectedContent({ resultEntry, ariaLabel: click.ariaLabel, detailSignals });
  if (detailSignals?.isDetail && detailSignals?.hasMoreOptions) {
    log({
      ok: true,
      phase: 'direct-play-attempt',
      status: 'detail-landed',
      selectedContent,
      clickedControlRole: click.clickedControlRole,
      pageKindBefore: beforeState?.pageKind || null,
      pageKindAfter: detailSignals?.pageKind || null,
      detailSignals,
    });
    return { ok: true, mode: 'open-detail', selectedContent, detailSignals, click };
  }

  log({
    ok: true,
    phase: 'direct-play-attempt',
    status: 'direct-play',
    selectedContent,
    clickedControlRole: click.clickedControlRole,
    pageKindBefore: beforeState?.pageKind || null,
    pageKindAfter: detailSignals?.pageKind || null,
    detailSignals,
  });
  return { ok: true, mode: 'direct-play', selectedContent, detailSignals, click };
}

function attemptExpand({
  runner,
  targetId,
  queryPlan,
  query,
  resultEntry,
  playbackHistory,
  log,
}) {
  let expansion = { expanded: false, clicked: { ok: false, reason: 'view-all-not-found' } };
  if (resultEntry?.expandTarget) {
    const scopedExpandClick = performCandidateClick(runner, targetId, resultEntry, { mode: 'expand' });
    const clickOk = scopedExpandClick?.indexResult?.ok || scopedExpandClick?.nativeClick?.ok;
    if (clickOk) {
      runner.waitMs(1500);
      expansion = {
        expanded: true,
        clicked: scopedExpandClick?.nativeClick || scopedExpandClick?.indexResult,
        scoped: true,
        clickedControlRole: scopedExpandClick.clickedControlRole,
      };
      log({ ok: true, phase: 'result-expander', expanded: true, scoped: true, clicked: expansion.clicked });
    }
  }
  if (!expansion.expanded) {
    expansion = clickViewAllIfPresent(runner, targetId, {
      queryPlan,
      query,
      sectionHint: resultEntry.sectionLabel || resultEntry.scopeText || '',
      log,
    });
  }
  if (!expansion.expanded) {
    return { ok: false, reason: expansion.clicked?.reason || 'view-all-not-found', expansion };
  }

  const searchResults = extractRealSearchResults(runner, targetId);
  const catalog = extractCatalog(runner, targetId);
  const ranking = selectBestCandidate({
    queryPlan,
    query,
    searchResults,
    catalog,
    playbackHistory,
    log,
  });
  const nextEntry = ranking.selected;
  if (!nextEntry) {
    return { ok: false, reason: 'no-candidate-after-expand', expansion, ranking };
  }

  const detailAttempt = attemptOpenDetail(runner, targetId, nextEntry, log);
  if (!detailAttempt.ok) {
    return {
      ok: false,
      reason: 'expanded-detail-failed',
      expansion,
      ranking,
      selectedEntry: nextEntry,
      detailSignals: detailAttempt.detailSignals,
    };
  }

  return {
    ok: true,
    mode: 'open-detail',
    selectedContent: detailAttempt.selectedContent,
    detailSignals: detailAttempt.detailSignals,
    selectedEntry: nextEntry,
    ranking,
    expansion,
  };
}

function engageCandidate({
  runner,
  targetId,
  queryPlan,
  query,
  resultEntry,
  searchResults,
  catalog,
  playbackHistory,
  actionPreference,
  log,
}) {
  const attempts = [];
  let currentEntry = resultEntry;
  const strategy = queryPlan?.strategy || queryPlan?.intentProfile?.strategy || 'default';

  const openDetailAttempt = attemptOpenDetail(runner, targetId, currentEntry, log);
  attempts.push({ mode: 'open-detail', ok: openDetailAttempt.ok, reason: openDetailAttempt.reason || null });
  if (openDetailAttempt.ok) {
    return {
      mode: 'open-detail',
      selectedContent: openDetailAttempt.selectedContent,
      selectedEntry: currentEntry,
      detailSignals: openDetailAttempt.detailSignals,
      attempts,
      ranking: { selected: currentEntry, searchResults, catalog },
    };
  }

  try {
    const rowMenuAttempt = attemptMenuPlayOnResult(runner, targetId, currentEntry, actionPreference, log);
    attempts.push({ mode: 'row-menu-action', ok: rowMenuAttempt.ok, reason: rowMenuAttempt.reason || null, actionName: rowMenuAttempt.actionName || null });
    if (rowMenuAttempt.ok) {
      return {
        mode: rowMenuAttempt.mode,
        selectedContent: rowMenuAttempt.selectedContent,
        selectedEntry: currentEntry,
        detailSignals: rowMenuAttempt.detailSignals,
        attempts,
        ranking: { selected: currentEntry, searchResults, catalog },
        actionName: rowMenuAttempt.actionName,
        menuItems: rowMenuAttempt.menuItems,
      };
    }
  } catch (error) {
    attempts.push({ mode: 'row-menu-action', ok: false, reason: error?.code || error?.message || 'row-menu-action-failed' });
  }

  if (strategy === 'playlist-first') {
    attempts.push({ mode: 'expand', ok: false, reason: 'strategy-locked-open-detail-only' });
    attempts.push({ mode: 'direct-play', ok: false, reason: 'strategy-locked-open-detail-only' });
    throw new SkillError('detail-page', 'PLAYLIST_DETAIL_NOT_REACHED', 'Playlist-first candidate did not land on an actionable menu/detail path.', {
      selectedResult: currentEntry?.clickLabel || currentEntry?.title || null,
      strategy,
      allowedTypes: resolveAllowedTypes(queryPlan),
      attempts,
      diagnostic: diagnose(runner, targetId, 'detail-page', 'playlist-first open-detail/menu', 'playlist detail entry and row menu both failed'),
    });
  }

  const expandAttempt = attemptExpand({
    runner,
    targetId,
    queryPlan,
    query,
    resultEntry: currentEntry,
    playbackHistory,
    log,
  });
  attempts.push({ mode: 'expand', ok: expandAttempt.ok, reason: expandAttempt.reason || null });
  if (expandAttempt.ok) {
    return {
      mode: 'open-detail',
      selectedContent: expandAttempt.selectedContent,
      selectedEntry: expandAttempt.selectedEntry || currentEntry,
      detailSignals: expandAttempt.detailSignals,
      attempts,
      ranking: expandAttempt.ranking,
    };
  }

  if (expandAttempt?.selectedEntry) {
    currentEntry = expandAttempt.selectedEntry;
  }

  const allowDirectPlay = shouldAllowDirectPlay(currentEntry, queryPlan.requestKind, strategy);
  if (allowDirectPlay) {
    const directAttempt = attemptDirectPlay(runner, targetId, currentEntry, log);
    attempts.push({ mode: 'direct-play', ok: directAttempt.ok, reason: directAttempt.reason || null });
    if (directAttempt.ok) {
      return {
        mode: directAttempt.mode,
        selectedContent: directAttempt.selectedContent,
        selectedEntry: currentEntry,
        detailSignals: directAttempt.detailSignals,
        attempts,
        ranking: { selected: currentEntry, searchResults, catalog },
      };
    }
  } else {
    attempts.push({ mode: 'direct-play', ok: false, reason: 'direct-play-not-allowed' });
  }

  throw new SkillError('detail-page', 'DETAIL_PAGE_NOT_REACHED', 'Result click did not land on an actionable detail or direct play path.', {
    selectedResult: currentEntry?.clickLabel || currentEntry?.title || null,
    attempts,
    diagnostic: diagnose(runner, targetId, 'detail-page', 'candidate state machine', 'all interaction paths failed'),
  });
}

function openMoreMenu(runner, targetId, log, options = {}) {
  const explicitMoreIndex = Number.isFinite(options?.moreIndex) ? options.moreIndex : null;
  const detailSignals = explicitMoreIndex == null ? readDetailSignals(runner, targetId) : null;
  const moreIndex = explicitMoreIndex ?? detailSignals?.topLevelMoreOptionsIndex ?? null;
  if (moreIndex == null) {
    throw new SkillError('menu-open', 'TOP_LEVEL_MENU_NOT_FOUND', 'No 更多选项 control was available for the selected content.', {
      detailSignals,
      requestedMoreIndex: explicitMoreIndex,
    });
  }
  const openResult = runner.evaluate(
    targetId,
    `() => {
      const moreIndex = ${JSON.stringify(moreIndex)};
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const isTableDescendant = (el) => !!el?.closest('[role="table"],[role="row"],tr,[role="grid"],table');
      const interactive = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el, index) => ({ el, index, text: textOf(el) }));
      const target = interactive.find((entry) => entry.index === moreIndex && !isTableDescendant(entry.el));
      if (!target) {
        return {
          ok: false,
          reason: 'more-options-click-target-lost',
          moreIndex,
          interactiveSample: interactive.slice(0, 20).map((entry) => ({ index: entry.index, text: entry.text })),
        };
      }
      target.el.click();
      return { ok: true, moreIndex };
    }`
  );
  const opened = openResult?.result || openResult;
  if (!opened?.ok) {
    throw new SkillError('menu-open', 'TOP_LEVEL_MENU_NOT_FOUND', 'Failed to open the 更多选项 menu.', {
      diagnostic: diagnose(runner, targetId, 'menu-open', 'more-options click', opened?.reason || 'not found'),
    });
  }

  runner.waitMs(600);
  const menuItems = runner.readVisibleMenuItems(targetId).map(normalizeMenuLabel).filter(Boolean);
  const uniqueItems = [...new Set(menuItems)];
  log({ ok: true, phase: 'menu-open', menuItems: uniqueItems, detailSignals, moreIndex });

  if (!uniqueItems.length) {
    throw new SkillError('menu-open', 'TOP_LEVEL_MENU_NOT_FOUND', 'The 更多选项 menu opened but no actionable items were readable.');
  }

  return uniqueItems;
}

function chooseAction(runner, targetId, menuItems, actionPreference, log) {
  const priority = ACTION_PRIORITY[actionPreference] || ACTION_PRIORITY['replace-first'];
  const selected = priority.find((label) => menuItems.includes(label));

  if (!selected) {
    throw new SkillError('menu-action', 'PLAY_ACTION_NOT_FOUND', 'No permitted playback action was present in the rendered menu.', {
      menuItems,
      requestedPriority: priority,
    });
  }

  const clickResult = runner.evaluate(
    targetId,
    `() => {
      const label = ${JSON.stringify(selected)};
      const button = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')]
        .find((el) => {
          const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
          return text === label || (label === '替换队列' && ['替换当前歌单', '替换播放列表', '替换队列'].includes(text));
        });
      if (!button) return { ok: false, reason: 'menu-button-not-found', label };
      button.click();
      return { ok: true, label };
    }`
  );
  const clicked = clickResult?.result || clickResult;
  if (!clicked?.ok) {
    throw new SkillError('menu-action', 'PLAY_ACTION_NOT_FOUND', 'Failed to click the selected playback action.', {
      selected,
      menuItems,
    });
  }

  log({ ok: true, phase: 'menu-action', actionName: selected, menuItems });
  return selected;
}

function attemptMenuPlayOnResult(runner, targetId, resultEntry, actionPreference, log) {
  const moreIndex = resultEntry?.moreOptionsTarget?.index;
  if (!Number.isFinite(moreIndex)) {
    return { ok: false, reason: 'row-more-options-missing' };
  }
  const menuItems = openMoreMenu(runner, targetId, log, { moreIndex });
  const actionName = chooseAction(runner, targetId, menuItems, actionPreference, log);
  return {
    ok: true,
    mode: 'row-menu-action',
    selectedContent: resultEntry?.title || resultEntry?.clickLabel || null,
    selectedEntry: resultEntry,
    detailSignals: readDetailSignals(runner, targetId),
    actionName,
    menuItems,
  };
}

export function runMediaFlow({ runner, queryPlan, room, actionPreference, playbackHistory = [], log }) {
  const targetId = runner.ensureSonosTab();
  ensureSearchReady(runner, targetId, log);
  const roomSync = syncActiveRoom(runner, targetId, room, log);
  const strategy = queryPlan?.strategy || queryPlan?.intentProfile?.strategy || 'default';
  const allowedTypes = resolveAllowedTypes(queryPlan);
  const maxCandidateAttempts = Number.isFinite(queryPlan?.intentProfile?.maxCandidateAttemptsPerQuery)
    ? queryPlan.intentProfile.maxCandidateAttemptsPerQuery
    : 2;
  const minCandidateScore = Number.isFinite(queryPlan?.intentProfile?.minCandidateScore)
    ? queryPlan.intentProfile.minCandidateScore
    : DEFAULT_MIN_CANDIDATE_SCORE;
  let lastFailure = null;

  for (const query of queryPlan.queries) {
    search(runner, targetId, query, log);
    let context = readContentContext(runner, targetId);
    log({ ok: true, phase: 'page-context', query, context: summarizePageContext(context) });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!context || ['SEARCH_HISTORY', 'SEARCH_SHELL_DIRTY', 'SEARCH_READY'].includes(context.pageKind)) {
        runner.waitMs(500);
        context = readContentContext(runner, targetId);
        log({ ok: true, phase: 'page-context', query, attempt, context: summarizePageContext(context) });
      }
    }

    if (context?.pageKind === 'SEARCH_HISTORY') {
      lastFailure = { phase: 'search', code: 'SEARCH_HISTORY_PAGE', context: summarizePageContext(context) };
      log({ ok: true, phase: 'query-rotation', query, reason: 'SEARCH_HISTORY_PAGE', strategy, allowedTypes, action: 'reuse-search-and-shrink-query' });
      ensureSearchReady(runner, targetId, log, { forceNavigate: false });
      continue;
    }
    if (context?.pageKind === 'SEARCH_SHELL_DIRTY') {
      lastFailure = { phase: 'search', code: 'SEARCH_SHELL_DIRTY', context: summarizePageContext(context) };
      log({ ok: true, phase: 'query-rotation', query, reason: 'SEARCH_SHELL_DIRTY', strategy, allowedTypes, action: 'reset-search-surface-before-next-query' });
      ensureSearchReady(runner, targetId, log, { forceNavigate: true });
      continue;
    }
    if (context?.pageKind === 'SEARCH_READY' || context?.pageKind === 'UNKNOWN') {
      const health = readSearchHealth(runner, targetId);
      const reason = health.blankShell ? 'SEARCH_PAGE_BROKEN' : 'NO_RESULT_RENDERED';
      const action = health.blankShell ? 'hard-reset-search-surface' : 'reuse-search-and-shrink-query';
      lastFailure = { phase: 'search', code: reason, context: summarizePageContext(context), health: { status: health.status, blankShell: health.blankShell, hasInput: health.hasInput, bodyPreview: health.bodyPreview } };
      log({ ok: true, phase: 'query-rotation', query, reason, strategy, allowedTypes, action, health: { status: health.status, blankShell: health.blankShell, hasInput: health.hasInput, bodyPreview: health.bodyPreview } });
      ensureSearchReady(runner, targetId, log, { forceNavigate: health.blankShell });
      continue;
    }

    const sectionInfo = getSectionInfo(context, 'playlist');
    let expansion = { expanded: false, clicked: { ok: false }, availableSections: sectionInfo.matches.map((entry) => entry.sectionKind) };
    const useClusterFlow = isSearchQueryApplied(context, query) && ['SEARCH_RESULTS_MIXED', 'SEARCH_RESULTS_PLAYLISTS'].includes(context?.pageKind);

    if (!useClusterFlow && strategy === 'playlist-first' && context?.pageKind === 'SEARCH_RESULTS_MIXED') {
      if (sectionInfo.hasViewAll) {
        expansion = clickViewAllIfPresent(runner, targetId, { queryPlan, query, log });
        if (expansion.expanded) {
          context = readContentContext(runner, targetId);
          log({ ok: true, phase: 'page-context', query, event: 'post-view-all', context: summarizePageContext(context) });
        }
        if (expansion.expanded && context?.pageKind !== 'SEARCH_RESULTS_PLAYLISTS') {
          runner.waitMs(500);
          context = readContentContext(runner, targetId);
          if (context?.pageKind !== 'SEARCH_RESULTS_PLAYLISTS') {
            lastFailure = { phase: 'results', code: 'PLAYLIST_RESULTS_PAGE_NOT_REACHED', context: summarizePageContext(context) };
            log({ ok: true, phase: 'query-rotation', query, reason: 'PLAYLIST_RESULTS_PAGE_NOT_REACHED', strategy, allowedTypes });
            ensureSearchReady(runner, targetId, log);
            continue;
          }
        }
      } else if (!sectionInfo.hasSection) {
        runner.waitMs(500);
        context = readContentContext(runner, targetId);
        const retriedSectionInfo = getSectionInfo(context, 'playlist');
        if (!retriedSectionInfo.hasSection && context?.pageKind !== 'SEARCH_RESULTS_PLAYLISTS') {
          lastFailure = { phase: 'results', code: 'PLAYLIST_SECTION_MISSING', context: summarizePageContext(context) };
          log({
            ok: true,
            phase: 'query-rotation',
            query,
            reason: 'PLAYLIST_SECTION_MISSING',
            strategy,
            allowedTypes,
            availableSections: summarizePageContext(context)?.availableSections || [],
          });
          ensureSearchReady(runner, targetId, log);
          continue;
        }
      }
    }

    const searchResults = extractRealSearchResults(runner, targetId);
    const catalog = extractCatalog(runner, targetId, {
      sectionKind: null,
      pageKind: context?.pageKind,
    });
    const queryApplied = isSearchQueryApplied(context, query);
    const resultClusterConfirmed = queryApplied && isResultCluster(context, searchResults, catalog);
    const effectiveSearchResults = searchResults;
    const ranking = selectBestCandidate({
      queryPlan,
      query,
      searchResults: effectiveSearchResults,
      catalog,
      playbackHistory,
      log,
    });
    const clusterSelection = {
      ordered: ranking.ranked || [],
      selected: ranking.selected || null,
      debug: ranking.debug?.clusterDebug || null,
    };

    const rankedCandidates = (ranking.ranked || []).slice(0, maxCandidateAttempts);

    log({
      ok: true,
      phase: 'execution-candidate-pool',
      query,
      strategy,
      allowedTypes: [],
      resultClusterConfirmed,
      selectionMode: 'page-order-history-rotation',
      clusterDebug: clusterSelection?.debug || null,
      executionSelected: rankedCandidates[0] ? {
        title: rankedCandidates[0].title,
        type: rankedCandidates[0].type || 'unknown',
        targetIndex: rankedCandidates[0].targetIndex ?? null,
        source: rankedCandidates[0].source || null,
        interactionMode: rankedCandidates[0].interactionMode || null,
      } : null,
      executionPoolTop: rankedCandidates.slice(0, 5).map((entry) => ({
        title: entry.title,
        type: entry.type || 'unknown',
        targetIndex: entry.targetIndex ?? null,
        source: entry.source || null,
        interactionMode: entry.interactionMode || null,
      })),
      rankerSelected: null,
    });

    log({
      ok: true,
      phase: 'search-results',
      query,
      strategy,
      allowedTypes,
      queryApplied,
      resultClusterConfirmed,
      sectionChosen: expansion?.selected?.sectionKind || null,
      realResultCount: searchResults?.candidates?.length || 0,
      selectedCandidate: rankedCandidates[0]?.title || clusterSelection?.selected?.title || ranking.selected?.title || null,
      expandedResults: expansion.expanded,
      candidatePoolSize: rankedCandidates.length,
      sample: catalog?.sample || searchResults?.sample || [],
    });

    if (!rankedCandidates.length) {
      lastFailure = { phase: 'results', code: 'NO_PLAYLIST_CANDIDATE', context: summarizePageContext(context) };
      log({
        ok: true,
        phase: 'query-rotation',
        query,
        reason: 'NO_PLAYLIST_CANDIDATE',
        strategy,
        allowedTypes,
        topScore: null,
        minCandidateScore: null,
      });
      ensureSearchReady(runner, targetId, log);
      continue;
    }

    let engagement = null;
    let selectedEntry = null;

    for (const candidate of rankedCandidates) {
      try {
        const attempt = engageCandidate({
          runner,
          targetId,
          queryPlan: resultClusterConfirmed ? { ...queryPlan, strategy: 'default', allowedTypes: [] } : queryPlan,
          query,
          resultEntry: candidate,
          searchResults: effectiveSearchResults,
          catalog,
          playbackHistory,
          actionPreference,
          log,
        });
        engagement = attempt;
        selectedEntry = candidate;
        break;
      } catch (error) {
        if (error instanceof SkillError) {
          lastFailure = { phase: error.phase, code: error.code, candidate: candidate.title, data: error.data };
          log({ ok: true, phase: 'detail-page', status: 'failed', candidate: candidate.title, error: { phase: error.phase, code: error.code } });
          continue;
        }
        throw error;
      }
    }

    if (!engagement) {
      lastFailure = lastFailure || { phase: 'detail', code: 'PLAYLIST_DETAIL_NOT_REACHED', context: summarizePageContext(context) };
      log({ ok: true, phase: 'query-rotation', query, reason: lastFailure.code, strategy, allowedTypes });
      ensureSearchReady(runner, targetId, log);
      continue;
    }

    let menuItems = engagement.menuItems || [];
    let actionName = engagement.actionName || 'direct-play';
    if (engagement.mode === 'open-detail') {
      let menuError = null;
      let menuOpened = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          menuItems = openMoreMenu(runner, targetId, log);
          menuOpened = true;
          break;
        } catch (error) {
          menuError = error;
          log({
            ok: true,
            phase: 'menu-open-retry',
            attempt,
            reason: error?.code || error?.message || 'unknown',
            rule: 'full-re-resolve-retry',
          });
          if (attempt >= 2) break;

          const reopen = attemptOpenDetail(runner, targetId, selectedEntry, log, { retries: 0 });
          if (!reopen.ok) {
            menuError = new SkillError('menu-open', 'TOP_LEVEL_MENU_NOT_FOUND', 'Menu click target was lost and detail-page re-resolve also failed.', {
              reopen,
              priorError: error?.code || error?.message || null,
            });
            break;
          }
          runner.waitMs(300);
        }
      }
      if (!menuOpened || !menuItems.length) {
        throw new SkillError('menu-open', 'TOP_LEVEL_MENU_NOT_FOUND', 'Failed to open the top-level playlist menu after full re-resolve retry.', {
          lastError: menuError?.message || null,
          rule: 'full-re-resolve-retry',
        });
      }
      actionName = chooseAction(runner, targetId, menuItems, actionPreference, log);
    }

    const finalRanking = engagement.ranking?.ranked ? engagement.ranking : ranking;

    return {
      targetId,
      room,
      query,
      selectedContent: engagement.selectedContent,
      selectedType: selectedEntry?.type || ranking.selected?.type || 'unknown',
      ranking: finalRanking,
      actionName,
      menuItems,
      roomSync,
      attemptedQueries: queryPlan.queries,
    };
  }

  if (lastFailure) {
    throw new SkillError(lastFailure.phase || 'search-results', lastFailure.code || 'NO_SEARCH_RESULTS', 'All planned Sonos queries failed to yield an actionable playlist.', {
      intent: queryPlan.intent,
      attemptedQueries: queryPlan.queries,
      lastFailure,
    });
  }

  throw new SkillError('search-results', 'NO_SEARCH_RESULTS', 'All planned Sonos queries either rendered no real results or only noisy results.', {
    intent: queryPlan.intent,
    attemptedQueries: queryPlan.queries,
  });
}
