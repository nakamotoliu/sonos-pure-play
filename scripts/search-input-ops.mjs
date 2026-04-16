import { normalizeWhitespace, SkillError } from './normalize.mjs';

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

export function replaceVisibleSearchValue(
  runner,
  targetId,
  query,
  { label = '搜索', submit = true, triggerTrailingSpace = false } = {}
) {
  const focus = focusVisibleSearchInput(runner, targetId, label);
  runner.press(targetId, 'Meta+A');
  runner.waitMs(120);
  runner.press(targetId, 'Backspace');
  runner.waitMs(180);
  runner.type(targetId, query);
  runner.waitMs(180);
  if (triggerTrailingSpace) {
    runner.type(targetId, ' ');
    runner.waitMs(220);
  }
  if (submit) runner.press(targetId, 'Enter');
  const after = readVisibleSearchInput(runner, targetId, label);
  const expectedValue = triggerTrailingSpace ? `${query} ` : query;
  const retained = normalizeWhitespace(after?.value || '') === normalizeWhitespace(expectedValue);
  return {
    ok: retained,
    focus,
    after,
    retained,
    query: normalizeWhitespace(query),
    triggerTrailingSpace,
    expectedValue,
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
