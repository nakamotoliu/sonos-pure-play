import { normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';
import { shouldUseAriaSnapshotFallback } from './aria-snapshot-tools.mjs';
import { buildDetectSearchPageStateFn, classifySearchPageStateFromAriaSnapshot } from './search-page-state.mjs';
import { SEARCH_URL } from './selectors.mjs';

function nowMs() {
  return Date.now();
}

function emitRunnerEvent(runner, event) {
  if (typeof runner?.log === 'function') runner.log(event);
}

function runTimedStage(runner, targetId, stage, meta, fn) {
  const startedAt = nowMs();
  emitRunnerEvent(runner, {
    event: 'query-gate-substage-start',
    targetId,
    stage,
    ...meta,
  });
  const result = fn();
  emitRunnerEvent(runner, {
    event: 'query-gate-substage-finished',
    targetId,
    stage,
    durationMs: nowMs() - startedAt,
    ok: true,
    ...meta,
  });
  return result;
}

function buildWriteSearchValueFn(query, requestedLabel = '搜索') {
  return `() => {
    const expectedQuery = ${JSON.stringify(query)};
    const requested = ${JSON.stringify(requestedLabel)};
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const safeStyle = (el) => {
      try { return window.getComputedStyle(el); } catch { return null; }
    };
    const isStrictVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const isSoftVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = safeStyle(el);
      if (!style) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const readValue = (el) => ('value' in el ? el.value : (el?.textContent || '')) || '';
    const setElementValue = (el, value) => {
      if (!el) return;
      if (typeof el.value !== 'undefined') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      }
    };
    const dispatchInputEvents = (el, value) => {
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })); } catch {}
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); } catch {}
      try { el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true })); } catch {}
      try { el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })); } catch {}
      try { el.form?.requestSubmit?.(); } catch {}
    };
    const scoreCandidate = (el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      let score = 0;
      if (requested && (aria === requested || placeholder === requested)) score += 100;
      if (requested && (aria.includes(requested) || placeholder.includes(requested))) score += 40;
      if (role === 'searchbox') score += 80;
      if (role === 'combobox') score += 70;
      if (el.tagName === 'INPUT') score += 30;
      if (type === 'search') score += 60;
      if (placeholder.includes('搜索')) score += 30;
      if (aria.includes('搜索')) score += 30;
      if (document.activeElement === el) score += 20;
      if (isStrictVisible(el)) score += 20;
      else if (isSoftVisible(el)) score += 10;
      return { el, score, aria, placeholder, role, strictVisible: isStrictVisible(el), softVisible: isSoftVisible(el) };
    };
    const rawCandidates = [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
    ];
    const deduped = [...new Set(rawCandidates)].filter((el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      return (
        role === 'searchbox' ||
        role === 'combobox' ||
        type === 'search' ||
        aria.includes('搜索') ||
        placeholder.includes('搜索') ||
        (!!requested && (aria.includes(requested) || placeholder.includes(requested)))
      );
    });
    const scored = deduped.map(scoreCandidate).sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    if (!best || (!best.strictVisible && !best.softVisible)) {
      return {
        ok: false,
        reason: 'search-input-not-found',
        candidateCount: scored.length,
      };
    }
    const el = best.el;
    try { el.focus?.({ preventScroll: true }); } catch {}
    try { el.click?.(); } catch {}
    try { el.select?.(); } catch {}
    setElementValue(el, expectedQuery);
    try { el.setSelectionRange?.(expectedQuery.length, expectedQuery.length); } catch {}
    dispatchInputEvents(el, expectedQuery);
    return {
      ok: true,
      value: normalize(readValue(el)),
      expectedValue: normalize(expectedQuery),
      matchedBy: best.strictVisible ? 'strict-visible' : 'soft-visible',
      candidateCount: scored.length,
      tag: el.tagName || '',
      role: best.role,
      aria: best.aria,
      placeholder: best.placeholder,
    };
  }`;
}

function buildFindVisibleSearchInputFn(requestedLabel = '') {
  return `() => {
    const requested = ${JSON.stringify(requestedLabel)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const safeStyle = (el) => {
      try { return window.getComputedStyle(el); } catch { return null; }
    };
    const isStrictVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const isSoftVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = safeStyle(el);
      if (!style) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const readValue = (el) => ('value' in el ? el.value : (el?.textContent || '')) || '';
    const scoreCandidate = (el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      let score = 0;
      if (requested && (aria === requested || placeholder === requested)) score += 100;
      if (requested && (aria.includes(requested) || placeholder.includes(requested))) score += 40;
      if (role === 'searchbox') score += 80;
      if (role === 'combobox') score += 70;
      if (el.tagName === 'INPUT') score += 30;
      if (type === 'search') score += 60;
      if (placeholder.includes('搜索')) score += 30;
      if (aria.includes('搜索')) score += 30;
      if (document.activeElement === el) score += 20;
      if (isStrictVisible(el)) score += 20;
      else if (isSoftVisible(el)) score += 10;
      return { el, score, aria, placeholder, role, type, strictVisible: isStrictVisible(el), softVisible: isSoftVisible(el) };
    };
    const rawCandidates = [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
    ];
    const deduped = [...new Set(rawCandidates)].filter((el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      return (
        role === 'searchbox' ||
        role === 'combobox' ||
        type === 'search' ||
        aria.includes('搜索') ||
        placeholder.includes('搜索') ||
        (!!requested && (aria.includes(requested) || placeholder.includes(requested)))
      );
    });
    const scored = deduped.map(scoreCandidate).sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    if (!best || (!best.strictVisible && !best.softVisible)) {
      return {
        ok: false,
        reason: 'search-input-not-found',
        candidateCount: scored.length,
        best: best ? {
          tag: best.el?.tagName || '',
          role: best.role,
          aria: best.aria,
          placeholder: best.placeholder,
          strictVisible: best.strictVisible,
          softVisible: best.softVisible,
          score: best.score,
        } : null,
      };
    }
    return {
      ok: true,
      tag: best.el.tagName,
      role: best.role,
      aria: best.aria,
      placeholder: best.placeholder,
      value: normalize(readValue(best.el)),
      strictVisible: best.strictVisible,
      softVisible: best.softVisible,
      matchedBy: best.strictVisible ? 'strict-visible' : 'soft-visible',
      candidateCount: scored.length,
    };
  }`;
}

export function readVisibleSearchInput(runner, targetId, label = '搜索') {
  try {
    const result = runner.evaluate(targetId, buildFindVisibleSearchInputFn(label));
    return result?.result || result || { ok: false, reason: 'search-input-read-failed' };
  } catch (error) {
    if (!shouldUseAriaSnapshotFallback(error)) throw error;
    const snapshot = runner.snapshot(targetId, 220);
    const state = classifySearchPageStateFromAriaSnapshot(snapshot, { label });
    return {
      ok: Boolean(state?.visibleSearchBoxCount),
      tag: 'SNAPSHOT',
      role: 'combobox',
      aria: label,
      placeholder: '',
      value: '',
      strictVisible: Boolean(state?.visibleSearchBoxCount),
      softVisible: Boolean(state?.visibleSearchBoxCount),
      matchedBy: 'aria-snapshot',
      candidateCount: Number(state?.visibleSearchBoxCount || 0),
      analysisMode: 'aria-snapshot',
    };
  }
}

export function focusVisibleSearchInput(runner, targetId, label = '搜索') {
  const result = runner.evaluate(
    targetId,
    `() => {
      const requested = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const safeStyle = (el) => {
        try { return window.getComputedStyle(el); } catch { return null; }
      };
      const isStrictVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const isSoftVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = safeStyle(el);
        if (!style) return false;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };
      const scoreCandidate = (el) => {
        const aria = normalize(el.getAttribute('aria-label') || '');
        const placeholder = normalize(el.getAttribute('placeholder') || '');
        const role = normalize(el.getAttribute('role') || '');
        const type = normalize(el.getAttribute('type') || '');
        let score = 0;
        if (requested && (aria === requested || placeholder === requested)) score += 100;
        if (requested && (aria.includes(requested) || placeholder.includes(requested))) score += 40;
        if (role === 'searchbox') score += 80;
        if (role === 'combobox') score += 70;
        if (el.tagName === 'INPUT') score += 30;
        if (type === 'search') score += 60;
        if (placeholder.includes('搜索')) score += 30;
        if (aria.includes('搜索')) score += 30;
        if (document.activeElement === el) score += 20;
        if (isStrictVisible(el)) score += 20;
        else if (isSoftVisible(el)) score += 10;
        return { el, score, aria, placeholder, role, strictVisible: isStrictVisible(el), softVisible: isSoftVisible(el) };
      };
      const rawCandidates = [
        ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
        ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
      ];
      const deduped = [...new Set(rawCandidates)].filter((el) => {
        const aria = normalize(el.getAttribute('aria-label') || '');
        const placeholder = normalize(el.getAttribute('placeholder') || '');
        const role = normalize(el.getAttribute('role') || '');
        const type = normalize(el.getAttribute('type') || '');
        return (
          role === 'searchbox' ||
          role === 'combobox' ||
          type === 'search' ||
          aria.includes('搜索') ||
          placeholder.includes('搜索') ||
          (!!requested && (aria.includes(requested) || placeholder.includes(requested)))
        );
      });
      const scored = deduped.map(scoreCandidate).sort((a, b) => b.score - a.score);
      const best = scored[0] || null;
      if (!best || (!best.strictVisible && !best.softVisible)) {
        return {
          ok: false,
          reason: 'search-input-not-found',
          candidateCount: scored.length,
          best: best ? {
            tag: best.el?.tagName || '',
            role: best.role,
            aria: best.aria,
            placeholder: best.placeholder,
            strictVisible: best.strictVisible,
            softVisible: best.softVisible,
            score: best.score,
          } : null,
        };
      }
      best.el.focus?.({ preventScroll: true });
      best.el.click?.();
      best.el.select?.();
      return {
        ok: true,
        tag: best.el.tagName,
        role: best.role,
        aria: best.aria,
        placeholder: best.placeholder,
        strictVisible: best.strictVisible,
        softVisible: best.softVisible,
        matchedBy: best.strictVisible ? 'strict-visible' : 'soft-visible',
        candidateCount: scored.length,
      };
    }`
  );
  const focused = result?.result || result || { ok: false, reason: 'search-input-focus-failed' };
  if (!focused?.ok) {
    throw new SkillError('search-input', 'SEARCH_INPUT_NOT_FOUND', 'Failed to locate a visible Sonos search input.', {
      label,
      focused,
    });
  }
  return focused;
}

export function replaceVisibleSearchValue(
  runner,
  targetId,
  query,
  { label = '搜索', submit = true, triggerTrailingSpace = false, settleTimeoutMs = 1200, settleIntervalMs = 120, inputReadyTimeoutMs = 4000, inputReadyIntervalMs = 180, verifyRetention = false } = {}
) {
  const normalizedQuery = normalizeWhitespace(query);
  const current = runTimedStage(runner, targetId, 'input-read-current', { query: normalizedQuery, label }, () =>
    readVisibleSearchInput(runner, targetId, label)
  );
  if (current?.ok && normalizeText(current.value || '') === normalizeText(normalizedQuery)) {
    return {
      ok: true,
      skippedWrite: true,
      query: normalizedQuery,
      after: current,
      retained: true,
      expectedValue: normalizedQuery,
      inputReady: { ok: true, result: current },
    };
  }

  const readyStartedAt = nowMs();
  emitRunnerEvent(runner, {
    event: 'query-gate-substage-start',
    targetId,
    stage: 'input-ready',
    query: normalizedQuery,
    label,
  });
  const inputReady = typeof runner.waitForCondition === 'function'
    ? runner.waitForCondition(
        'search-input-ready',
        () => readVisibleSearchInput(runner, targetId, label),
        {
          timeoutMs: inputReadyTimeoutMs,
          intervalMs: inputReadyIntervalMs,
          ready: (value) => Boolean(value?.ok),
        }
      )
    : null;
  emitRunnerEvent(runner, {
    event: 'query-gate-substage-finished',
    targetId,
    stage: 'input-ready',
    query: normalizedQuery,
    durationMs: nowMs() - readyStartedAt,
    ok: inputReady ? Boolean(inputReady.ok) : true,
    candidateCount: inputReady?.result?.candidateCount ?? null,
    matchedBy: inputReady?.result?.matchedBy || '',
    reason: inputReady?.result?.reason || '',
  });
  if (inputReady && !inputReady.ok) {
    throw new SkillError('search-input', 'SEARCH_INPUT_NOT_FOUND', 'Visible Sonos search input did not become ready in time.', {
      label,
      inputReady,
    });
  }

  const writeResult = runTimedStage(runner, targetId, 'input-write-once', { query: normalizedQuery, label, submit, triggerTrailingSpace }, () => {
    try {
      return runner.evaluate(targetId, buildWriteSearchValueFn(normalizedQuery, label));
    } catch (error) {
      if (error?.code === 'BROWSER_ATTACH_FAILED' && !shouldUseAriaSnapshotFallback(error)) throw error;
      throw new SkillError(
        'search-input',
        'SEARCH_INPUT_ACTION_UNSUPPORTED',
        'Current browser runtime supports aria snapshot reads, but Sonos search input writes require Playwright browser actions that are unavailable in this gateway build.',
        {
          query: normalizedQuery,
          label,
          targetId,
          originalCode: error?.code || null,
          originalMessage: String(error?.message || error),
        }
      );
    }
  });
  const write = writeResult?.result || writeResult || { ok: false, reason: 'search-input-write-failed' };

  let after = runTimedStage(runner, targetId, 'input-readback', { query: normalizedQuery, label }, () =>
    readVisibleSearchInput(runner, targetId, label)
  );
  let retained = Boolean(after?.ok && normalizeText(after?.value || '').includes(normalizeText(normalizedQuery)));
  let settled = null;
  if (!retained && verifyRetention) {
    settled = typeof runner.waitForCondition === 'function'
      ? runner.waitForCondition(
          'search-input-value-retained',
          () => {
            const readAfter = readVisibleSearchInput(runner, targetId, label);
            const readRetained = Boolean(readAfter?.ok && normalizeText(readAfter?.value || '').includes(normalizeText(normalizedQuery)));
            return {
              ok: readRetained,
              after: readAfter,
              retained: readRetained,
            };
          },
          {
            timeoutMs: settleTimeoutMs,
            intervalMs: settleIntervalMs,
            ready: (value) => Boolean(value?.retained),
          }
        )
      : null;
    after = settled?.result?.after || after;
    retained = settled?.result?.retained ?? retained;
  }

  return {
    ok: retained,
    skippedWrite: false,
    write,
    after,
    retained,
    query: normalizedQuery,
    triggerTrailingSpace,
    expectedValue: normalizedQuery,
    settled,
    inputReady,
  };
}

export function ensureSearchValue(runner, targetId, query, options = {}) {
  const effectiveOptions = {
    triggerTrailingSpace: false,
    submit: true,
    ...options,
  };
  const attempt = replaceVisibleSearchValue(runner, targetId, query, effectiveOptions);
  if (!attempt.ok) {
    throw new SkillError('search-input', 'SEARCH_INPUT_WRITE_FAILED', 'Visible Sonos search input did not retain the requested query.', {
      query,
      attempt,
      effectiveOptions,
    });
  }
  return attempt;
}

export function assessQueryGateState(state = {}, query = '', { requireFreshResults = false } = {}) {
  const normalizedQuery = normalizeText(query);
  const normalizedValue = normalizeText(state?.searchValue || '');
  const queryApplied = Boolean(
    normalizedQuery &&
    (state?.queryApplied || normalizedValue === normalizedQuery)
  );
  const freshResults = Boolean(state?.resultsFreshForExpectedQuery);
  const ok = Boolean(state?.searchPageReady && queryApplied && (!requireFreshResults || freshResults));
  return {
    ok,
    searchPageReady: Boolean(state?.searchPageReady),
    queryApplied,
    pageKind: state?.pageKind || 'UNKNOWN',
    searchValue: normalizeWhitespace(state?.searchValue || ''),
    historyVisible: Boolean(state?.historyVisible),
    resultsFreshForExpectedQuery: freshResults,
    visibleSearchBoxCount: Number(state?.visibleSearchBoxCount || 0),
    activeElementRole: state?.activeElementRole || '',
    activeElementTag: state?.activeElementTag || '',
  };
}

function buildCheckSearchQueryAppliedFn(query, requestedLabel = '搜索') {
  return `() => {
    const expectedQuery = ${JSON.stringify(query)};
    const requested = ${JSON.stringify(requestedLabel)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const normalizeText = (value) => normalize(value).toLowerCase();
    const safeStyle = (el) => {
      try { return window.getComputedStyle(el); } catch { return null; }
    };
    const isStrictVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const isSoftVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = safeStyle(el);
      if (!style) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const readValue = (el) => ('value' in el ? el.value : (el?.textContent || '')) || '';
    const scoreCandidate = (el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      let score = 0;
      if (requested && (aria === requested || placeholder === requested)) score += 100;
      if (requested && (aria.includes(requested) || placeholder.includes(requested))) score += 40;
      if (role === 'searchbox') score += 80;
      if (role === 'combobox') score += 70;
      if (el.tagName === 'INPUT') score += 30;
      if (type === 'search') score += 60;
      if (placeholder.includes('搜索')) score += 30;
      if (aria.includes('搜索')) score += 30;
      if (document.activeElement === el) score += 20;
      if (isStrictVisible(el)) score += 20;
      else if (isSoftVisible(el)) score += 10;
      return { el, score, role, strictVisible: isStrictVisible(el), softVisible: isSoftVisible(el) };
    };
    const rawCandidates = [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
    ];
    const deduped = [...new Set(rawCandidates)].filter((el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      const type = normalize(el.getAttribute('type') || '');
      return (
        role === 'searchbox' ||
        role === 'combobox' ||
        type === 'search' ||
        aria.includes('搜索') ||
        placeholder.includes('搜索') ||
        (!!requested && (aria.includes(requested) || placeholder.includes(requested)))
      );
    });
    const scored = deduped.map(scoreCandidate).sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    const searchValue = normalize(best ? readValue(best.el) : '');
    const normalizedExpected = normalizeText(expectedQuery);
    const normalizedActual = normalizeText(searchValue);
    const queryApplied = Boolean(normalizedExpected && normalizedActual && normalizedActual === normalizedExpected);
    const searchPageReady = Boolean(location.href.includes('/search') && best && (best.strictVisible || best.softVisible));
    return {
      ok: Boolean(queryApplied),
      searchPageReady,
      queryApplied,
      pageKind: searchPageReady ? (queryApplied ? 'SEARCH_QUERY_VISIBLE' : 'SEARCH_READY') : 'UNKNOWN',
      searchValue,
      historyVisible: false,
      visibleSearchBoxCount: scored.filter((entry) => entry.strictVisible || entry.softVisible).length,
      activeElementRole: document.activeElement?.getAttribute?.('role') || '',
      activeElementTag: document.activeElement?.tagName || '',
      state: {
        url: location.href,
        title: document.title || '',
        searchValue,
        visibleSearchBoxCount: scored.filter((entry) => entry.strictVisible || entry.softVisible).length,
        activeElementRole: document.activeElement?.getAttribute?.('role') || '',
        activeElementTag: document.activeElement?.tagName || '',
      },
    };
  }`;
}

export function checkSearchQueryApplied(runner, targetId, query, options = {}) {
  const { label = '搜索', mode = 'full' } = options;
  try {
    if (mode === 'full') {
      const result = runner.evaluate(targetId, buildDetectSearchPageStateFn({ expectedQuery: query }));
      const state = result?.result || result || {};
      return {
        ...assessQueryGateState(state, query, options),
        state,
      };
    }
    const result = runner.evaluate(targetId, buildCheckSearchQueryAppliedFn(query, label));
    const state = result?.result || result || {};
    return {
      ...assessQueryGateState(state, query, options),
      state: state?.state || state,
    };
  } catch (error) {
    if (!shouldUseAriaSnapshotFallback(error)) throw error;
    const snapshot = runner.snapshot(targetId, 220);
    const state = classifySearchPageStateFromAriaSnapshot(snapshot, { expectedQuery: query, label });
    return {
      ...assessQueryGateState(state, query, options),
      state,
    };
  }
}

export function ensureQueryGate(runner, targetId, query, options = {}) {
  const {
    label = '搜索',
    triggerTrailingSpace = false,
    submit = true,
    inputAttempts = 2,
    pageReloads = 1,
    settleMs = 450,
    reloadSettleMs = 1200,
    freshTimeoutMs = 8000,
    freshIntervalMs = 180,
  } = options;

  const attempts = [];
  const normalizedQuery = normalizeWhitespace(query);

  for (let reloadIndex = 0; reloadIndex <= pageReloads; reloadIndex += 1) {
    if (reloadIndex > 0) {
      const reloadStartedAt = nowMs();
      emitRunnerEvent(runner, {
        event: 'query-gate-substage-start',
        targetId,
        stage: 'page-reload',
        query: normalizedQuery,
        reloadIndex,
      });
      runner.navigate(targetId, SEARCH_URL);
      runner.waitForLoad(targetId);
      runner.waitMs(reloadSettleMs);
      emitRunnerEvent(runner, {
        event: 'query-gate-substage-finished',
        targetId,
        stage: 'page-reload',
        query: normalizedQuery,
        reloadIndex,
        durationMs: nowMs() - reloadStartedAt,
        ok: true,
      });
    }

    for (let inputIndex = 0; inputIndex < inputAttempts; inputIndex += 1) {
      emitRunnerEvent(runner, {
        event: 'query-gate-attempt-start',
        targetId,
        query: normalizedQuery,
        reloadIndex,
        inputIndex,
      });

      const before = runTimedStage(runner, targetId, 'query-read-before', { query: normalizedQuery, label, reloadIndex, inputIndex }, () =>
        checkSearchQueryApplied(runner, targetId, normalizedQuery, { label, mode: 'full', requireFreshResults: true })
      );
      if (before?.ok) {
        const attempt = { reloadIndex, inputIndex, skippedWrite: true, gate: before };
        attempts.push(attempt);
        emitRunnerEvent(runner, {
          event: 'query-gate-attempt-finished',
          targetId,
          query: normalizedQuery,
          reloadIndex,
          inputIndex,
          ok: true,
          searchPageReady: Boolean(before?.searchPageReady),
          queryApplied: Boolean(before?.queryApplied),
        });
        return {
          ok: true,
          query: normalizedQuery,
          attempt,
          attempts,
        };
      }

      const write = replaceVisibleSearchValue(runner, targetId, normalizedQuery, {
        label,
        submit,
        triggerTrailingSpace,
        verifyRetention: false,
      });
      const confirmStartedAt = nowMs();
      emitRunnerEvent(runner, {
        event: 'query-gate-substage-start',
        targetId,
        stage: 'query-confirm',
        query: normalizedQuery,
        reloadIndex,
        inputIndex,
        settleMs,
      });
      const settledGate = typeof runner.waitForCondition === 'function'
        ? runner.waitForCondition(
            'search-query-gate',
            () => checkSearchQueryApplied(runner, targetId, normalizedQuery, { label, mode: 'full', requireFreshResults: true }),
            {
              timeoutMs: freshTimeoutMs,
              intervalMs: freshIntervalMs,
              ready: (value) => Boolean(value?.ok),
            }
          )
        : null;
      if (!settledGate) runner.waitMs(settleMs);
      const gate = settledGate?.result || checkSearchQueryApplied(runner, targetId, normalizedQuery, { label, mode: 'full', requireFreshResults: true });
      emitRunnerEvent(runner, {
        event: 'query-gate-substage-finished',
        targetId,
        stage: 'query-confirm',
        query: normalizedQuery,
        reloadIndex,
        inputIndex,
        durationMs: nowMs() - confirmStartedAt,
        ok: Boolean(gate?.ok),
        searchPageReady: Boolean(gate?.searchPageReady),
        queryApplied: Boolean(gate?.queryApplied),
        pageKind: gate?.pageKind || '',
        searchValue: gate?.searchValue || '',
        visibleSearchBoxCount: gate?.visibleSearchBoxCount ?? null,
      });
      const attempt = { reloadIndex, inputIndex, write, gate };
      attempts.push(attempt);
      emitRunnerEvent(runner, {
        event: 'query-gate-attempt-finished',
        targetId,
        query: normalizedQuery,
        reloadIndex,
        inputIndex,
        ok: Boolean(gate?.ok),
        searchPageReady: Boolean(gate?.searchPageReady),
        queryApplied: Boolean(gate?.queryApplied),
      });
      if (gate.ok) {
        return {
          ok: true,
          query: normalizedQuery,
          attempt,
          attempts,
        };
      }
    }
  }

  throw new SkillError(
    'query-gate',
    'QUERY_NOT_CONFIRMED',
    'Search query was not confirmed in the visible Sonos search input after the allowed retries.',
    {
      query: normalizedQuery,
      attempts,
      options: {
        label,
        triggerTrailingSpace,
        submit,
        inputAttempts,
        pageReloads,
        settleMs,
        reloadSettleMs,
        freshTimeoutMs,
        freshIntervalMs,
      },
    }
  );
}
