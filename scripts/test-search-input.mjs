#!/usr/bin/env node
import { PurePlayBrowserRunner } from './browser-runner.mjs';
import { SEARCH_URL } from './selectors.mjs';
import { extractUsablePageBlocks } from './browser-surface-tools.mjs';

function emit(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: node test-search-input.mjs <query>');
  process.exit(2);
}

const runner = new PurePlayBrowserRunner({
  profile: process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw',
  logger: (event) => emit(event),
});

emit({ phase: 'test-search-input', event: 'start', query, searchUrl: SEARCH_URL });

emit({ phase: 'test-search-input', event: 'before-ensure-sonos-tab' });
const targetId = runner.ensureSonosTab();
emit({ phase: 'test-search-input', event: 'after-ensure-sonos-tab', targetId });

emit({ phase: 'test-search-input', event: 'before-wait-for-load', targetId });
runner.waitForLoad(targetId);
emit({ phase: 'test-search-input', event: 'after-wait-for-load', targetId });

emit({ phase: 'test-search-input', event: 'before-post-load-wait', ms: 1200 });
runner.waitMs(1200);
emit({ phase: 'test-search-input', event: 'after-post-load-wait', ms: 1200 });

emit({ phase: 'test-search-input', event: 'before-focus-evaluate', targetId });
const focus = runner.evaluate(targetId, `() => {
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const candidates = [...document.querySelectorAll('[role="combobox"],[role="searchbox"],input[type="search"],input,textarea')]
    .filter(visible);
  const scored = candidates.map((el, index) => {
    const role = (el.getAttribute('role') || '').trim();
    const placeholder = (el.getAttribute('placeholder') || '').trim();
    const rect = el.getBoundingClientRect();
    let score = 0;
    if (role === 'combobox') score += 100;
    if (role === 'searchbox') score += 90;
    if (el.tagName === 'INPUT' && el.type === 'search') score += 80;
    if (placeholder.includes('搜索')) score += 70;
    if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) score += 40;
    score -= Math.abs(rect.top);
    score -= index;
    return { el, score, role, placeholder, top: rect.top };
  }).sort((a, b) => b.score - a.score);
  const chosen = scored[0]?.el || null;
  if (!chosen) return { ok: false, reason: 'no-visible-search-input', candidates: scored.map(x => ({ role: x.role, placeholder: x.placeholder, top: x.top, score: x.score })) };
  chosen.scrollIntoView({ block: 'center', inline: 'nearest' });
  chosen.focus();
  chosen.click?.();
  const active = document.activeElement;
  const readValue = (el) => ('value' in el ? el.value : (el.textContent || '')) || '';
  return {
    ok: active === chosen,
    role: chosen.getAttribute('role') || '',
    placeholder: chosen.getAttribute('placeholder') || '',
    activeRole: active?.getAttribute?.('role') || '',
    activeTag: active?.tagName || '',
    activeValue: active ? readValue(active) : '',
  };
}`);
emit({ phase: 'test-search-input', event: 'after-focus-evaluate', step: 'focus', result: focus?.result || focus });

emit({ phase: 'test-search-input', event: 'before-clear-select-all', key: 'Meta+A' });
runner.press(targetId, 'Meta+A');
emit({ phase: 'test-search-input', event: 'after-clear-select-all', key: 'Meta+A' });
runner.waitMs(200);
emit({ phase: 'test-search-input', event: 'after-clear-select-all-wait', ms: 200 });

emit({ phase: 'test-search-input', event: 'before-clear-backspace', key: 'Backspace' });
runner.press(targetId, 'Backspace');
emit({ phase: 'test-search-input', event: 'after-clear-backspace', key: 'Backspace' });
runner.waitMs(300);
emit({ phase: 'test-search-input', event: 'after-clear-backspace-wait', ms: 300 });

emit({ phase: 'test-search-input', event: 'before-clear-check' });
const cleared = runner.evaluate(targetId, `() => {
  const active = document.activeElement;
  const readValue = (el) => ('value' in el ? el.value : (el.textContent || '')) || '';
  return {
    ok: !!active && !String(readValue(active) || '').trim(),
    activeTag: active?.tagName || '',
    activeRole: active?.getAttribute?.('role') || '',
    activeValue: active ? readValue(active) : '',
  };
}`);
emit({ phase: 'test-search-input', event: 'after-clear-check', step: 'clear', result: cleared?.result || cleared });

emit({ phase: 'test-search-input', event: 'before-type', query });
runner.type(targetId, query);
emit({ phase: 'test-search-input', event: 'after-type', query });
runner.waitMs(500);
emit({ phase: 'test-search-input', event: 'after-type-wait', ms: 500 });

emit({ phase: 'test-search-input', event: 'before-type-check' });
const typed = runner.evaluate(targetId, `() => {
  const active = document.activeElement;
  const readValue = (el) => ('value' in el ? el.value : (el.textContent || '')) || '';
  return {
    ok: !!active,
    activeTag: active?.tagName || '',
    activeRole: active?.getAttribute?.('role') || '',
    activeValue: active ? readValue(active) : '',
  };
}`);
emit({ phase: 'test-search-input', event: 'after-type-check', step: 'type', query, result: typed?.result || typed });

emit({ phase: 'test-search-input', event: 'before-trigger-space', text: ' ' });
runner.type(targetId, ' ');
emit({ phase: 'test-search-input', event: 'after-trigger-space', text: ' ' });
runner.waitMs(900);
emit({ phase: 'test-search-input', event: 'after-trigger-space-wait', ms: 900 });

emit({ phase: 'test-search-input', event: 'before-submit', key: 'Enter' });
runner.press(targetId, 'Enter');
emit({ phase: 'test-search-input', event: 'after-submit', key: 'Enter' });
runner.waitMs(1600);
emit({ phase: 'test-search-input', event: 'after-submit-wait', ms: 1600 });

emit({ phase: 'test-search-input', event: 'before-surface-read' });
const surface = extractUsablePageBlocks(runner, targetId);
emit({
  phase: 'test-search-input',
  event: 'after-surface-read',
  usableBlocks: {
    inputs: surface?.usableBlocks?.inputs?.slice?.(0, 5) || [],
    serviceTabs: surface?.usableBlocks?.serviceTabs?.slice?.(0, 10) || [],
    candidates: surface?.usableBlocks?.candidates?.slice?.(0, 10) || [],
    menuActions: surface?.usableBlocks?.menuActions?.slice?.(0, 10) || [],
    rows: surface?.usableBlocks?.rows?.slice?.(0, 10) || [],
  },
});

emit({ phase: 'test-search-input', event: 'before-final-check' });
const finalState = runner.evaluate(targetId, `() => {
  const active = document.activeElement;
  const readValue = (el) => ('value' in el ? el.value : (el.textContent || '')) || '';
  const bodyText = document.body?.innerText || '';
  return {
    ok: true,
    url: location.href,
    activeTag: active?.tagName || '',
    activeRole: active?.getAttribute?.('role') || '',
    activeValue: active ? readValue(active) : '',
    bodyPreview: bodyText.slice(0, 400),
  };
}`);
emit({ phase: 'test-search-input', event: 'after-final-check', step: 'final', result: finalState?.result || finalState });
