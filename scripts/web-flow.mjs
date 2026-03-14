import { normalizeMenuLabel, normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';
import { ACTION_PRIORITY, SEARCH_URL } from './selectors.mjs';

const BLOCKED_RESULT_PATTERNS = /sonos radio|tunein|直播|电台|广播|更多选项|播放群组|暂停群组|上一首|下一首|设置为有效|搜索记录|查看全部|查看所有|刷新|退出/i;
const REAL_SERVICE_PATTERN = /网易云音乐|QQ音乐/;
const ROOM_CONTROL_PATTERNS = /群组|房间|音量|设置为有效|客厅|工作室|卧室|厨房|书房/;

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
      const textOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const main = document.querySelector('main') || document.body;
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
          const isPlayable = /^播放/.test(text);
          const isBlocked =
            !!el.closest('header,nav,footer,[role="dialog"]') ||
            /sonos radio|tunein|直播|电台|广播|更多选项|播放群组|暂停群组|上一首|下一首|设置为有效|搜索记录|查看全部|查看所有|刷新|退出/i.test(text) ||
            /群组|房间|音量|设置为有效|客厅|工作室|卧室|厨房|书房/.test(text);
          const looksLikeContent = /(播放列表|歌单|专辑|艺术家|艺人|歌曲|单曲|热门|精选|心情好|快乐|开心|欢快|元气)/.test(scopeText);
          return {
            index,
            text,
            scopeText,
            service,
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

function pickFirstRealMatch(searchResults, query) {
  const candidates = Array.isArray(searchResults?.candidates) ? searchResults.candidates : [];
  const scored = candidates
    .filter((entry) => {
      if (BLOCKED_RESULT_PATTERNS.test(entry.text) || ROOM_CONTROL_PATTERNS.test(entry.text)) return false;
      if (entry.service && REAL_SERVICE_PATTERN.test(entry.service)) return true;
      return entry.looksLikeContent;
    })
    .map((entry) => ({ ...entry, score: scoreResult({ name: entry.text }, query) + (entry.looksLikeContent ? 15 : 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

function openFirstMatch(runner, targetId, resultEntry, log) {
  const ariaLabel = String(resultEntry.text || '').trim();
  const nativeClick = runner.evaluate(
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
  runner.waitMs(1500);
  const detailSnapshot = runner.snapshot(targetId, 320);
  const moreButton = detailSnapshot.nodes.find((node) => node.role === 'button' && /更多选项/.test(nodeText(node)));

  if (!moreButton) {
    throw new SkillError('detail-page', 'DETAIL_PAGE_NOT_REACHED', 'Result click did not land on a detail page with 更多选项.', {
      selectedResult: ariaLabel,
      nativeClick: nativeClick?.result || nativeClick,
      diagnostic: diagnose(runner, targetId, 'detail-page', 'native page-context play button click', '更多选项 missing'),
    });
  }

  const selectedContent = normalizeWhitespace(ariaLabel.replace(/^播放/, ''));
  log({ ok: true, phase: 'detail-page', selectedContent, nativeClick: nativeClick?.result || nativeClick });
  return { selectedContent, moreButton };
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

export function runMediaFlow({ runner, queryPlan, room, actionPreference, log }) {
  const targetId = runner.ensureSonosTab();
  ensureSearchReady(runner, targetId, log);
  const roomSync = syncActiveRoom(runner, targetId, room, log);

  for (const query of queryPlan.queries) {
    search(runner, targetId, query, log);
    const searchResults = extractRealSearchResults(runner, targetId);
    const firstMatch = pickFirstRealMatch(searchResults, query);

    log({
      ok: true,
      phase: 'search-results',
      query,
      realResultCount: searchResults?.candidates?.length || 0,
      firstCandidate: searchResults?.candidates?.[0]?.text || null,
      selectedCandidate: firstMatch?.text || null,
      sample: searchResults?.sample || [],
    });

    if (!firstMatch) {
      log({ ok: true, phase: 'query-rotation', query, reason: 'no-real-results' });
      continue;
    }

    const detail = openFirstMatch(runner, targetId, firstMatch, log);
    const menuItems = openMoreMenu(runner, targetId, log);
    const actionName = chooseAction(runner, targetId, menuItems, actionPreference, log);

    return {
      targetId,
      room,
      query,
      selectedContent: detail.selectedContent,
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
