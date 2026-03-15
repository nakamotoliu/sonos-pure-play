import { normalizeMenuLabel, normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';
import { rankCandidates } from './candidate-ranker.mjs';
import { ACTION_PRIORITY, SEARCH_URL } from './selectors.mjs';

const BLOCKED_RESULT_PATTERNS = /sonos radio|tunein|直播|电台|广播|更多选项|播放群组|暂停群组|上一首|下一首|设置为有效|搜索记录|查看全部|查看所有|刷新|退出/i;
const REAL_SERVICE_PATTERN = /网易云音乐|QQ音乐/;
const ROOM_CONTROL_PATTERNS = /群组|房间|音量|设置为有效|客厅|工作室|卧室|厨房|书房/;
const BLOCKED_ZONES = new Set(['system-controls', 'now-playing-bar']);
const DEFAULT_MIN_CANDIDATE_SCORE = 12;
const MIN_VIEW_ALL_SELECTION_SCORE = 6;
const TITLE_BLOCKLIST = /更多选项|查看全部|查看所有|查看更多|返回|首页|设置为有效|群组|房间|音量/;

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

function ensureSearchReady(runner, targetId, log) {
  const state = runner.readPageState(targetId);
  log({ ok: true, phase: 'page-state', state });

  if (String(state.url || '').includes('/search')) {
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
}

function syncActiveRoom(runner, targetId, room, log) {
  const maxAttempts = 2;
  let lastState = null;
  let lastClickResult = null;

  const isSoftConfirmed = (state, clickResult) => {
    if (!clickResult?.ok) return false;
    const roomCards = Array.isArray(state?.roomCardSamples) ? state.roomCardSamples : [];
    return Boolean(
      state?.roomVisible &&
      roomCards.some((text) => String(text || '').includes(room))
    );
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = runner.readRoomSyncState(targetId, room);
    lastState = before;
    log({ ok: true, phase: 'active-room-sync', attempt, room, state: before });

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

    const clickResult = runner.clickRoomActivate(targetId, room);
    lastClickResult = clickResult;
    log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'click-activate', clickResult });
    runner.waitMs(1000);

    const after = runner.readRoomSyncState(targetId, room);
    lastState = after;
    log({ ok: true, phase: 'active-room-sync', attempt, room, event: 'post-click-state', state: after });

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
        reason: 'activate click landed and target room remains visible; defer final truth to CLI verification',
        confirmSignals: after.confirmSignals,
      });
      return {
        ...after,
        activeRoomConfirmed: true,
        softConfirmed: true,
      };
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
      const candidates = [
        ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
        ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
      ];
      const target = candidates.find((el) => {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const role = (el.getAttribute('role') || '').trim();
        if (requested && (aria === requested || placeholder === requested)) return true;
        if (role === 'searchbox' || role === 'combobox') return true;
        if (el.tagName === 'INPUT' && (el.type === 'search' || placeholder.includes('搜索'))) return true;
        return false;
      }) || document.querySelector('input[type="search"]');
      if (!target) return { ok: false, reason: 'search-input-not-found' };
      target.focus();
      if ('value' in target) target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, tag: target.tagName, placeholder: target.getAttribute('placeholder') || '', aria: target.getAttribute('aria-label') || '' };
    }`
  );
  const focused = focusResult?.result || focusResult;
  if (!focused?.ok) {
    throw new SkillError('search', 'SEARCH_INPUT_FOCUS_FAILED', 'Failed to focus the Sonos search input.', {
      diagnostic: diagnose(runner, targetId, 'search', 'focus search input before paste', focused?.reason || 'not found'),
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
  runner.waitMs(1200);
  log({ ok: true, phase: 'search', event: 'input-applied', input: focused });
}

function search(runner, targetId, query, log) {
  let lastSnapshot = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      ensureSearchReady(runner, targetId, log);
      log({ ok: true, phase: 'search', event: 'retry-after-dead-page', attempt });
    }

    const initialSnapshot = runner.snapshot(targetId, 220);
    const input = findSearchInput(initialSnapshot.nodes);
    setSearchInputValue(runner, targetId, input?.name || '搜索', query, log);
    const after = runner.snapshot(targetId, 320);
    const pageSearchState = inspectSearchSurface(runner, targetId);
    const bodyText = after.nodes.map((node) => nodeText(node)).join(' ');
    const hasSearchHistory = pageSearchState.hasSearchHistory || bodyText.includes('搜索记录');
    const hasResults =
      pageSearchState.hasPlayableButton ||
      pageSearchState.hasRenderedResults ||
      after.nodes.some((node) => /^播放/.test(String(node.name || '')) && /(网易云音乐|QQ音乐)/.test(nodeText(node)));
    lastSnapshot = after;

    log({
      ok: true,
      phase: 'search',
      attempt,
      hasSearchHistory,
      hasResults,
      pageSearchState,
    });
    if (hasResults || hasSearchHistory) {
      return after;
    }
  }

  throw new SkillError('search', 'SEARCH_DEAD_PAGE', 'Search input changed but Sonos did not render a live search page.', {
    diagnostic: diagnose(runner, targetId, 'search', 'focus + clipboard + paste', 'search page stayed dead'),
    snapshotNodeCount: lastSnapshot?.nodes?.length || 0,
  });
}

function extractRealSearchResults(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const classText = (el) => String(el?.className || '').toLowerCase();
      const attrText = (el, name) => String(el?.getAttribute(name) || '');
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const hasMoreOptions = [...document.querySelectorAll('button,[role="button"]')]
        .some((el) => visible(el) && /更多选项/.test(textOf(el)));
      const main = document.querySelector('main') || document.body;
      const mainZone = hasMoreOptions ? 'detail-content' : 'search-results';
      const zoneFor = (el) => {
        if (!el) return 'unknown';
        if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) {
          return 'now-playing-bar';
        }
        if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return 'now-playing-bar';
        if (el.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]')) {
          return 'system-controls';
        }
        if (attrText(el, 'aria-label').includes('正在播放')) return 'now-playing-bar';
        if (el.closest('main')) return mainZone;
        return 'unknown';
      };
      const controls = [...main.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el, index) => {
          const scopeText = [
            textOf(el),
            textOf(el.closest('li,article,section,[role="listitem"]')),
            textOf(el.closest('[role="region"]')),
            textOf(el.parentElement),
          ].join(' ');
          const text = textOf(el);
          const service = /网易云音乐|QQ音乐/.exec(scopeText)?.[0] || '';
          const zone = zoneFor(el);
          const isPlayable = /^播放/.test(text);
          const isBlocked =
            zone === 'system-controls' ||
            zone === 'now-playing-bar' ||
            !!el.closest('header,nav,footer,[role="dialog"]') ||
            /sonos radio|tunein|直播|电台|广播|更多选项|播放群组|暂停群组|上一首|下一首|设置为有效|搜索记录|查看全部|查看所有|刷新|退出/i.test(text) ||
            /群组|房间|音量|设置为有效|客厅|工作室|卧室|厨房|书房/.test(text);
          const looksLikeContent = /(播放列表|歌单|专辑|艺术家|艺人|歌曲|单曲|热门|精选|心情好|快乐|开心|欢快|元气)/.test(scopeText);
          return {
            index,
            text,
            scopeText,
            service,
            zone,
            isPlayable,
            isBlocked,
            looksLikeContent,
          };
        });

      const candidates = controls.filter((entry) => {
        if (!entry.isPlayable || entry.isBlocked) return false;
        if (entry.service && (entry.looksLikeContent || entry.text.length > 4)) return true;
        if (!entry.service && entry.looksLikeContent && entry.text.length > 4) return true;
        return false;
      });

      return {
        candidates,
        sample: controls.slice(0, 20),
      };
    }`
  );
  return result?.result || result;
}

function listViewAllCandidates(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const classText = (el) => String(el?.className || '').toLowerCase();
      const attrText = (el, name) => String(el?.getAttribute(name) || '');
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const hasMoreOptions = [...document.querySelectorAll('button,[role="button"]')]
        .some((el) => visible(el) && /更多选项/.test(textOf(el)));
      const mainZone = hasMoreOptions ? 'detail-content' : 'search-results';
      const zoneFor = (el) => {
        if (!el) return 'unknown';
        if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) {
          return 'now-playing-bar';
        }
        if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return 'now-playing-bar';
        if (el.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]')) {
          return 'system-controls';
        }
        if (attrText(el, 'aria-label').includes('正在播放')) return 'now-playing-bar';
        if (el.closest('main')) return mainZone;
        return 'unknown';
      };
      const interactive = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el, index) => {
          const scope = textOf(el.closest('section,li,article,[role="region"],[role="group"]'));
          const section = textOf(el.closest('section,[role="region"],[role="group"]')?.querySelector('h1,h2,h3,h4,[role="heading"]')) || scope;
          const text = textOf(el);
          const service = /网易云音乐|QQ音乐/.exec([text, scope, section].join(' '))?.[0] || '';
          const zone = zoneFor(el);
          return { index, text, scope, section, service, zone };
        });
      const candidates = interactive.filter((entry) => /查看全部|查看所有|查看更多/.test(entry.text));
      return { candidates };
    }`
  );
  const payload = result?.result || result;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return {
    ...payload,
    candidates: candidates.map((entry) => ({ ...entry, sectionKind: inferSectionKind(entry.section) })),
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
  const candidates = (Array.isArray(listed?.candidates) ? listed.candidates : [])
    .filter((entry) => !BLOCKED_ZONES.has(entry.zone));
  if (!candidates.length) {
    log({ ok: true, phase: 'result-expander', expanded: false, reason: 'view-all-not-found' });
    return { expanded: false, clicked: { ok: false, reason: 'view-all-not-found' }, rankedCandidates: [] };
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
      selected,
      rankedCandidates: rankedCandidates.slice(0, 3),
    });
    return {
      expanded: false,
      clicked: { ok: false, reason: 'view-all-score-too-low' },
      rankedCandidates,
      selected,
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
    rankedCandidates: rankedCandidates.slice(0, 3),
    selectedByIntent: selected,
  });
  if (!clicked?.ok) return { expanded: false, clicked, rankedCandidates };

  runner.waitMs(1500);
  return { expanded: true, clicked, rankedCandidates };
}

function extractCatalog(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const classText = (el) => String(el?.className || '').toLowerCase();
      const attrText = (el, name) => String(el?.getAttribute(name) || '');
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const hasMoreOptions = [...document.querySelectorAll('button,[role="button"]')]
        .some((el) => visible(el) && /更多选项/.test(textOf(el)));
      const mainZone = hasMoreOptions ? 'detail-content' : 'search-results';
      const zoneFor = (el) => {
        if (!el) return 'unknown';
        if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) {
          return 'now-playing-bar';
        }
        if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return 'now-playing-bar';
        if (el.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]')) {
          return 'system-controls';
        }
        if (attrText(el, 'aria-label').includes('正在播放')) return 'now-playing-bar';
        if (el.closest('main')) return mainZone;
        return 'unknown';
      };
      const headingFor = (el) => {
        const scope = el.closest('section,article,[role="region"],[role="group"],li,[role="listitem"]');
        if (!scope) return '';
        const heading = scope.querySelector('h1,h2,h3,h4,[role="heading"]');
        return textOf(heading || scope);
      };
      const controls = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
        .filter(visible)
        .map((el, index) => {
          const text = textOf(el);
          const container = el.closest('li,article,section,[role="listitem"],[role="region"],[role="group"]');
          const scopeText = textOf(container || el.parentElement);
          const sectionLabel = headingFor(el) || scopeText;
          const service = /网易云音乐|QQ音乐/.exec([scopeText, sectionLabel, text].join(' '))?.[0] || '';
          const zone = zoneFor(el);
          return {
            index,
            text,
            clickLabel: text,
            scopeText,
            sectionLabel,
            service,
            zone,
            isPlayable: /^播放/.test(text),
            isViewAll: /查看全部|查看所有|查看更多/.test(text),
          };
        });
      return {
        controls,
        sample: controls.slice(0, 30),
      };
    }`
  );
  return result?.result || result;
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
  const label = normalizeText(entry.clickLabel || entry.text || '');
  if (/查看全部|查看所有|查看更多|展开/.test(label)) return 'expand';
  if (entry.type === 'song' || requestKind === 'song') return 'direct-play';
  if (entry.type && entry.type !== 'generic') return 'open-detail';
  return 'unknown';
}

function shouldAllowDirectPlay(entry, requestKind) {
  if (!entry) return false;
  if (entry.interactionMode === 'direct-play') return true;
  if (entry.type === 'song') return true;
  if (requestKind === 'song') return true;
  return false;
}

function buildResultGroups(searchResults, catalog, requestKind) {
  const directCandidates = (Array.isArray(searchResults?.candidates) ? searchResults.candidates : [])
    .map((entry) => ({
      title: deriveCandidateTitle({ clickLabel: entry.text, scopeText: entry.scopeText, sectionLabel: entry.scopeText }),
      clickLabel: entry.text,
      targetIndex: entry.index,
      scopeText: entry.scopeText,
      sectionLabel: entry.scopeText,
      service: entry.service,
      type: inferCandidateType({ ...entry, sectionLabel: entry.scopeText }),
      zone: entry.zone,
      source: 'search-results',
    }))
    .map((entry) => ({ ...entry, interactionMode: inferInteractionMode(entry, requestKind) }));
  const catalogCandidates = (Array.isArray(catalog?.controls) ? catalog.controls : [])
    .filter((entry) => entry.isPlayable && !entry.isViewAll)
    .filter((entry) => !BLOCKED_RESULT_PATTERNS.test(entry.text) && !ROOM_CONTROL_PATTERNS.test(entry.scopeText))
    .filter((entry) => !BLOCKED_ZONES.has(entry.zone))
    .map((entry) => ({
      title: deriveCandidateTitle({ clickLabel: entry.text, scopeText: entry.scopeText, sectionLabel: entry.sectionLabel }),
      clickLabel: entry.clickLabel,
      targetIndex: entry.index,
      scopeText: entry.scopeText,
      sectionLabel: entry.sectionLabel,
      service: entry.service,
      type: inferCandidateType(entry),
      zone: entry.zone,
      source: 'catalog',
    }))
    .map((entry) => ({ ...entry, interactionMode: inferInteractionMode(entry, requestKind) }));
  const merged = [...directCandidates, ...catalogCandidates]
    .filter((entry) => entry.title)
    .filter((entry) => !BLOCKED_RESULT_PATTERNS.test(entry.title))
    .filter((entry) => !entry.service || REAL_SERVICE_PATTERN.test(entry.service))
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
    const type = entry.type === 'generic' ? 'playlist' : entry.type;
    groups[type] = groups[type] || [];
    groups[type].push({ ...entry, type });
    return groups;
  }, {});
}

function selectBestCandidate({ queryPlan, query, searchResults, catalog, playbackHistory, log }) {
  const resultGroups = buildResultGroups(searchResults, catalog, queryPlan.requestKind);
  const ranking = rankCandidates({
    originalIntent: queryPlan.originalIntent,
    query,
    requestKind: queryPlan.requestKind,
    resultGroups,
    playbackHistory,
    now: new Date().toISOString(),
  });

  log({
    ok: true,
    phase: 'candidate-ranker',
    query,
    resultGroups,
    selected: ranking.selected,
    rankedTop: ranking.ranked.slice(0, 5),
    debug: ranking.debug,
  });

  return ranking;
}

function performCandidateClick(runner, targetId, resultEntry) {
  const ariaLabel = String(resultEntry.clickLabel || resultEntry.text || '').trim();
  const indexClick = Number.isFinite(resultEntry.targetIndex)
    ? runner.evaluate(
      targetId,
      `() => {
        const targetIndex = ${JSON.stringify(resultEntry.targetIndex)};
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
    indexResult,
    nativeClick: nativeClick?.result || nativeClick,
  };
}

function readDetailSignals(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const classText = (el) => String(el?.className || '').toLowerCase();
      const attrText = (el, name) => String(el?.getAttribute(name) || '');
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const hasMoreOptions = [...document.querySelectorAll('button,[role="button"]')]
        .some((el) => visible(el) && /更多选项/.test(textOf(el)));
      const mainZone = hasMoreOptions ? 'detail-content' : 'search-results';
      const zoneFor = (el) => {
        if (!el) return 'unknown';
        if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) {
          return 'now-playing-bar';
        }
        if (classText(el).includes('now-playing') || classText(el).includes('nowplaying')) return 'now-playing-bar';
        if (el.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]')) {
          return 'system-controls';
        }
        if (attrText(el, 'aria-label').includes('正在播放')) return 'now-playing-bar';
        if (el.closest('main')) return mainZone;
        return 'unknown';
      };
      const buttons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
      const moreButtons = buttons.filter((el) => /更多选项/.test(textOf(el)));
      const moreButton = moreButtons.find((el) => !['system-controls', 'now-playing-bar'].includes(zoneFor(el))) || null;
      const detailContainer = moreButton
        ? moreButton.closest('section,article,[role="region"],[role="group"],main') || document.querySelector('main') || document.body
        : (document.querySelector('main') || document.body);
      const heading = detailContainer?.querySelector('h1,h2,h3,[role="heading"]');
      const headingText = textOf(heading);
      const containerText = textOf(detailContainer);
      const playButton = buttons.find((el) => /^播放/.test(textOf(el)) && detailContainer && detailContainer.contains(el));
      const service = /网易云音乐|QQ音乐/.exec([headingText, containerText].join(' '))?.[0] || '';
      const typeHint = /(播放列表|歌单|专辑|艺术家|艺人|歌曲|单曲|热门|精选)/.test(containerText);
      let score = 0;
      if (moreButton) score += 2;
      if (headingText) score += 1;
      if (playButton) score += 1;
      if (service) score += 1;
      if (typeHint) score += 1;
      const isDetail = score >= 3 && (moreButton || headingText || playButton);
      return {
        isDetail,
        score,
        headingText,
        containerTextSample: containerText.slice(0, 240),
        service,
        typeHint,
        hasMoreOptions: !!moreButton,
        moreButtonZone: moreButton ? zoneFor(moreButton) : null,
        playButtonLabel: playButton ? textOf(playButton) : null,
      };
    }`
  );
  return result?.result || result;
}

function deriveSelectedContent({ resultEntry, ariaLabel, detailSignals }) {
  return normalizeWhitespace(
    resultEntry.title ||
    detailSignals?.headingText ||
    String(ariaLabel || '').replace(/^播放/, '')
  );
}

function attemptOpenDetail(runner, targetId, resultEntry, log) {
  const click = performCandidateClick(runner, targetId, resultEntry);
  const clickOk = click?.indexResult?.ok || click?.nativeClick?.ok;
  runner.waitMs(1500);
  const detailSignals = readDetailSignals(runner, targetId);
  if (!clickOk || !detailSignals?.isDetail || !detailSignals?.hasMoreOptions) {
    log({
      ok: true,
      phase: 'detail-page-attempt',
      status: 'failed',
      selectedResult: click.ariaLabel,
      clickResult: click?.nativeClick || click?.indexResult || null,
      detailSignals,
    });
    return {
      ok: false,
      reason: !clickOk ? 'candidate-click-failed' : 'detail-signals-missing',
      click,
      detailSignals,
    };
  }

  const selectedContent = deriveSelectedContent({ resultEntry, ariaLabel: click.ariaLabel, detailSignals });
  log({ ok: true, phase: 'detail-page', selectedContent, clickResult: click?.nativeClick || click?.indexResult, detailSignals });
  return { ok: true, selectedContent, detailSignals, click };
}

function attemptDirectPlay(runner, targetId, resultEntry, log) {
  const click = performCandidateClick(runner, targetId, resultEntry);
  const clickOk = click?.indexResult?.ok || click?.nativeClick?.ok;
  runner.waitMs(1200);
  const detailSignals = readDetailSignals(runner, targetId);
  if (!clickOk) {
    log({
      ok: true,
      phase: 'direct-play-attempt',
      status: 'failed',
      selectedResult: click.ariaLabel,
      clickResult: click?.nativeClick || click?.indexResult || null,
      detailSignals,
    });
    return { ok: false, reason: 'candidate-click-failed', click, detailSignals };
  }

  const selectedContent = deriveSelectedContent({ resultEntry, ariaLabel: click.ariaLabel, detailSignals });
  if (detailSignals?.isDetail && detailSignals?.hasMoreOptions) {
    log({ ok: true, phase: 'direct-play-attempt', status: 'detail-landed', selectedContent, detailSignals });
    return { ok: true, mode: 'open-detail', selectedContent, detailSignals, click };
  }

  log({ ok: true, phase: 'direct-play-attempt', status: 'direct-play', selectedContent, detailSignals });
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
  const expansion = clickViewAllIfPresent(runner, targetId, {
    queryPlan,
    query,
    sectionHint: resultEntry.sectionLabel || resultEntry.scopeText || '',
    log,
  });
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
  log,
}) {
  const attempts = [];
  let currentEntry = resultEntry;

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

  const allowDirectPlay = shouldAllowDirectPlay(currentEntry, queryPlan.requestKind);
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

function openMoreMenu(runner, targetId, log) {
  const openResult = runner.evaluate(
    targetId,
    `() => {
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .find((el) => (el.getAttribute('aria-label') || el.textContent || '').includes('更多选项'));
      if (!button) return { ok: false, reason: 'more-options-not-found' };
      button.click();
      return { ok: true };
    }`
  );
  const opened = openResult?.result || openResult;
  if (!opened?.ok) {
    throw new SkillError('menu-open', 'MORE_MENU_NOT_FOUND', 'Failed to open the 更多选项 menu.', {
      diagnostic: diagnose(runner, targetId, 'menu-open', 'more-options click', opened?.reason || 'not found'),
    });
  }

  runner.waitMs(600);
  const menuItems = runner.readVisibleMenuItems(targetId).map(normalizeMenuLabel).filter(Boolean);
  const uniqueItems = [...new Set(menuItems)];
  log({ ok: true, phase: 'menu-open', menuItems: uniqueItems });

  if (!uniqueItems.length) {
    throw new SkillError('menu-open', 'MORE_MENU_NOT_FOUND', 'The 更多选项 menu opened but no actionable items were readable.');
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

export function runMediaFlow({ runner, queryPlan, room, actionPreference, playbackHistory = [], log }) {
  const targetId = runner.ensureSonosTab();
  ensureSearchReady(runner, targetId, log);
  const roomSync = syncActiveRoom(runner, targetId, room, log);

  for (const query of queryPlan.queries) {
    search(runner, targetId, query, log);
    const searchResults = extractRealSearchResults(runner, targetId);
    const expansion = clickViewAllIfPresent(runner, targetId, { queryPlan, query, log });
    const catalog = extractCatalog(runner, targetId);
    const effectiveSearchResults = expansion.expanded ? { candidates: [] } : searchResults;
    const ranking = selectBestCandidate({
      queryPlan,
      query,
      searchResults: effectiveSearchResults,
      catalog,
      playbackHistory,
      log,
    });
    const firstMatch = ranking.selected;
    const minCandidateScore = Number.isFinite(queryPlan?.intentProfile?.minCandidateScore)
      ? queryPlan.intentProfile.minCandidateScore
      : DEFAULT_MIN_CANDIDATE_SCORE;

    log({
      ok: true,
      phase: 'search-results',
      query,
      realResultCount: searchResults?.candidates?.length || 0,
      firstCandidate: searchResults?.candidates?.[0]?.text || null,
      selectedCandidate: firstMatch?.title || null,
      expandedResults: expansion.expanded,
      sample: catalog?.sample || searchResults?.sample || [],
    });

    if (!firstMatch || firstMatch.score < minCandidateScore) {
      log({
        ok: true,
        phase: 'query-rotation',
        query,
        reason: !firstMatch ? 'no-real-results' : 'top-score-too-low',
        topScore: firstMatch?.score || null,
        minCandidateScore,
      });
      ensureSearchReady(runner, targetId, log);
      continue;
    }

    const engagement = engageCandidate({
      runner,
      targetId,
      queryPlan,
      query,
      resultEntry: firstMatch,
      searchResults: effectiveSearchResults,
      catalog,
      playbackHistory,
      log,
    });

    let menuItems = [];
    let actionName = 'direct-play';
    if (engagement.mode === 'open-detail') {
      menuItems = openMoreMenu(runner, targetId, log);
      actionName = chooseAction(runner, targetId, menuItems, actionPreference, log);
    }

    const finalRanking = engagement.ranking?.ranked ? engagement.ranking : ranking;

    return {
      targetId,
      room,
      query,
      selectedContent: engagement.selectedContent,
      selectedType: engagement.selectedEntry?.type || firstMatch.type,
      ranking: finalRanking,
      actionName,
      menuItems,
      roomSync,
      attemptedQueries: queryPlan.queries,
    };
  }

  throw new SkillError('search-results', 'NO_SEARCH_RESULTS', 'All planned Sonos queries either rendered no real results or only noisy results.', {
    intent: queryPlan.intent,
    attemptedQueries: queryPlan.queries,
  });
}
