import { normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';
import { buildDetectSearchPageStateFn } from './search-page-state.mjs';
import { SEARCH_URL } from './selectors.mjs';

function buildFindVisibleSearchInputFn(requestedLabel = '') {
  return `() => {
    const requested = ${JSON.stringify(requestedLabel)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const candidates = [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
    ].filter(visible);
    const target = candidates.find((el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      if (requested && (aria === requested || placeholder === requested)) return true;
      if (role === 'searchbox' || role === 'combobox') return true;
      if (el.tagName === 'INPUT' && (el.type === 'search' || placeholder.includes('搜索'))) return true;
      return false;
    }) || document.querySelector('input[type="search"]');
    if (!target || !visible(target)) return { ok: false, reason: 'search-input-not-found' };
    const readValue = ('value' in target ? target.value : (target.textContent || '')) || '';
    return {
      ok: true,
      tag: target.tagName,
      role: target.getAttribute('role') || '',
      aria: target.getAttribute('aria-label') || '',
      placeholder: target.getAttribute('placeholder') || '',
      value: normalize(readValue),
    };
  }`;
}

export function readVisibleSearchInput(runner, targetId, label = '搜索') {
  const result = runner.evaluate(targetId, buildFindVisibleSearchInputFn(label));
  return result?.result || result || { ok: false, reason: 'search-input-read-failed' };
}

export function focusVisibleSearchInput(runner, targetId, label = '搜索') {
  const result = runner.evaluate(
    targetId,
    `() => {
      const requested = ${JSON.stringify(label)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const candidates = [
        ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
        ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
      ].filter(visible);
      const target = candidates.find((el) => {
        const aria = normalize(el.getAttribute('aria-label') || '');
        const placeholder = normalize(el.getAttribute('placeholder') || '');
        const role = normalize(el.getAttribute('role') || '');
        if (requested && (aria === requested || placeholder === requested)) return true;
        if (role === 'searchbox' || role === 'combobox') return true;
        if (el.tagName === 'INPUT' && (el.type === 'search' || placeholder.includes('搜索'))) return true;
        return false;
      }) || document.querySelector('input[type="search"]');
      if (!target || !visible(target)) return { ok: false, reason: 'search-input-not-found' };
      target.focus?.();
      target.click?.();
      return {
        ok: true,
        tag: target.tagName,
        role: target.getAttribute('role') || '',
        aria: target.getAttribute('aria-label') || '',
        placeholder: target.getAttribute('placeholder') || '',
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

function buildReplaceSearchValueFn(query, requestedLabel = '搜索', { submit = true, triggerTrailingSpace = false } = {}) {
  return `() => {
    const requested = ${JSON.stringify(requestedLabel)};
    const query = ${JSON.stringify(query)};
    const submit = ${JSON.stringify(Boolean(submit))};
    const triggerTrailingSpace = ${JSON.stringify(Boolean(triggerTrailingSpace))};
    const expectedValue = triggerTrailingSpace ? query + ' ' : query;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const candidates = [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      ...document.querySelectorAll('[role="combobox"],[role="searchbox"]')
    ].filter(visible);
    const target = candidates.find((el) => {
      const aria = normalize(el.getAttribute('aria-label') || '');
      const placeholder = normalize(el.getAttribute('placeholder') || '');
      const role = normalize(el.getAttribute('role') || '');
      if (requested && (aria === requested || placeholder === requested)) return true;
      if (role === 'searchbox' || role === 'combobox') return true;
      if (el.tagName === 'INPUT' && (el.type === 'search' || placeholder.includes('搜索'))) return true;
      return false;
    }) || document.querySelector('input[type="search"]');
    if (!target || !visible(target)) return { ok: false, reason: 'search-input-not-found' };
    const setValue = (el, value) => {
      if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      }
    };
    const readValue = () => normalize(('value' in target ? target.value : (target.textContent || '')) || '');
    target.focus?.({ preventScroll: true });
    target.click?.();
    target.select?.();
    setValue(target, expectedValue);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: expectedValue, inputType: 'insertText' }));
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      target.form?.requestSubmit?.();
    }
    const value = readValue();
    return {
      ok: normalize(value) === normalize(expectedValue),
      tag: target.tagName,
      role: target.getAttribute('role') || '',
      aria: target.getAttribute('aria-label') || '',
      placeholder: target.getAttribute('placeholder') || '',
      value,
      expectedValue: normalize(expectedValue),
    };
  }`;
}

export function replaceVisibleSearchValue(
  runner,
  targetId,
  query,
  { label = '搜索', submit = true, triggerTrailingSpace = false } = {}
) {
  const expectedValue = triggerTrailingSpace ? `${query} ` : query;
  const result = runner.evaluate(targetId, buildReplaceSearchValueFn(query, label, { submit, triggerTrailingSpace }));
  const after = result?.result || result || { ok: false, reason: 'search-input-write-failed' };
  const retained = Boolean(after?.ok && normalizeWhitespace(after?.value || '') === normalizeWhitespace(expectedValue));
  return {
    ok: retained,
    focus: after?.ok ? { ok: true, tag: after.tag, role: after.role, aria: after.aria, placeholder: after.placeholder } : { ok: false, reason: after?.reason || 'search-input-not-found' },
    after,
    retained,
    query: normalizeWhitespace(query),
    triggerTrailingSpace,
    expectedValue,
    settled: null,
  };
}

export function ensureSearchValue(runner, targetId, query, options = {}) {
  const effectiveOptions = {
    triggerTrailingSpace: true,
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

export function checkSearchQueryApplied(runner, targetId, query, options = {}) {
  const result = runner.evaluate(targetId, buildDetectSearchPageStateFn({ expectedQuery: query }));
  const state = result?.result || result || {};
  return {
    ...assessQueryGateState(state, query, options),
    state,
  };
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

  for (let reloadIndex = 0; reloadIndex <= pageReloads; reloadIndex += 1) {
    if (reloadIndex > 0) {
      runner.navigate(targetId, SEARCH_URL);
      runner.waitForLoad(targetId);
      runner.waitMs(reloadSettleMs);
    }

    for (let inputIndex = 0; inputIndex < inputAttempts; inputIndex += 1) {
      const before = checkSearchQueryApplied(runner, targetId, query, { requireFreshResults: true });
      if (before?.ok) {
        const attempt = { reloadIndex, inputIndex, write: { ok: true, skippedWrite: true }, gate: before };
        attempts.push(attempt);
        return {
          ok: true,
          query: normalizeWhitespace(query),
          attempt,
          attempts,
        };
      }
      const write = replaceVisibleSearchValue(runner, targetId, query, {
        label,
        submit,
        triggerTrailingSpace,
      });
      let gate = checkSearchQueryApplied(runner, targetId, query, { requireFreshResults: true });
      const freshStartedAt = Date.now();
      while (!gate.ok && gate.searchPageReady && gate.queryApplied && Date.now() - freshStartedAt <= freshTimeoutMs) {
        runner.waitMs(freshIntervalMs);
        gate = checkSearchQueryApplied(runner, targetId, query, { requireFreshResults: true });
      }
      const attempt = { reloadIndex, inputIndex, write, gate };
      attempts.push(attempt);
      if (gate.ok) {
        return {
          ok: true,
          query: normalizeWhitespace(query),
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
      query: normalizeWhitespace(query),
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
