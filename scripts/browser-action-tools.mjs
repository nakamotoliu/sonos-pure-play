import { normalizeMenuLabel, SkillError } from './normalize.mjs';

export function press(runner, targetId, key) {
  runner.oc(['press', key, '--target-id', targetId], { parseJson: false });
}

export function click(runner, targetId, ref) {
  runner.oc(['click', ref, '--target-id', targetId], { parseJson: false });
}

export function typeRef(runner, targetId, ref, text, { submit = false } = {}) {
  const args = ['type', ref, text, '--target-id', targetId];
  if (submit) args.push('--submit');
  const raw = runner.oc(args, { parseJson: false });
  return { ok: true, ref, text, submit, raw: String(raw || '').trim() };
}

export function fillRef(runner, targetId, ref, value) {
  const raw = runner.oc(
    ['fill', '--fields', JSON.stringify([{ ref, value }]), '--target-id', targetId],
    { parseJson: false }
  );
  return { ok: true, ref, value, raw: String(raw || '').trim() };
}

export function type(runner, targetId, text) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const active = document.activeElement;
      const readValue = (el) => ('value' in el ? el.value : (el?.textContent || '')) || '';
      if (!active) return { ok: false, reason: 'no-active-element' };
      active.focus?.();
      active.click?.();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const current = String(readValue(active) || '');
      const next = current + ${JSON.stringify(text)};
      if (setter && ('value' in active)) setter.call(active, next);
      else if ('value' in active) active.value = next;
      else active.textContent = next;
      active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        activeTag: active?.tagName || '',
        activeRole: active?.getAttribute?.('role') || '',
        activeValue: readValue(active),
      };
    }`
  );
  const typed = result?.result || result;
  if (!typed?.ok) {
    throw new SkillError('browser-action', 'TYPE_FAILED', 'Failed to type into the active browser element.', { targetId, text, typed });
  }
  return typed;
}

export function clickButtonByLabel(runner, targetId, labels = []) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const labels = ${JSON.stringify(['__LABELS__'])};
      const wanted = labels.filter((value) => value !== '__LABELS__');
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const buttons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
      for (const label of wanted) {
        const target = buttons.find((el) => textOf(el) === label);
        if (target) {
          target.click();
          return { ok: true, clicked: label };
        }
      }
      return {
        ok: false,
        reason: 'button-not-found',
        labels: wanted,
        visibleButtons: buttons.map((el) => textOf(el)).filter(Boolean).slice(0, 40),
      };
    }`
      .replace(JSON.stringify(['__LABELS__']), JSON.stringify(labels))
  );
  return result?.result || result;
}

export function clickRoomActivate(runner, targetId, room) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const targetRoom = ${JSON.stringify(room)};
      const exactActivateLabel = '将' + targetRoom + '设置为有效';
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const mentionNodes = [...document.querySelectorAll('button,[role="button"],a,[role="link"],li,article,section,div,span')]
        .filter(visible)
        .filter((el) => textOf(el).includes(targetRoom));
      const cardRootOf = (el) => {
        if (!el) return null;
        for (let current = el, depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const txt = textOf(current);
          if (!txt.includes(targetRoom)) continue;
          if (/设置为有效|输出选择器|播放群组|暂停群组/.test(txt)) return current;
        }
        return null;
      };
      const candidateCards = [...new Set(mentionNodes.map((el) => cardRootOf(el)).filter(Boolean))];
      const scored = candidateCards.map((card) => {
        const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
        const labels = buttons.map((el) => textOf(el)).filter(Boolean);
        const targetButton = buttons.find((el) => textOf(el) === exactActivateLabel) || null;
        const rect = card.getBoundingClientRect();
        const score = (textOf(card).includes(targetRoom) ? 10 : 0) + (targetButton ? 20 : 0);
        return { labels, targetButton, rect, score };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0] || null;
      if (!best) return { ok: false, reason: 'room-card-not-found', exactActivateLabel };
      if (!best.targetButton) {
        return {
          ok: true,
          skipped: true,
          reason: 'target-room-already-active',
          exactActivateLabel,
          roomCardButtons: best.labels.slice(0, 20),
        };
      }
      best.targetButton.click();
      return {
        ok: true,
        skipped: false,
        clicked: exactActivateLabel,
        roomCardButtons: best.labels.slice(0, 20),
        roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
      };
    }`
  );
  return result?.result || result;
}

function inspectPlaybackActionSurface(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute?.('aria-label') || el?.textContent || '');
      const interactiveSelector = 'button,[role="button"],a,[role="link"],[role="menuitem"]';
      const actionPattern = /替换当前歌单|替换播放列表|替换队列|立即播放|添加到队列末尾/;
      const main = document.querySelector('main') || document.body;
      const roots = [...main.querySelectorAll('main > div, main > section, main > article, main > [role="region"], main > [role="group"], main > *')]
        .filter(visible);
      const summarizeRoot = (root) => {
        const heading = textOf(root.querySelector('h1,h2,h3,h4,[role="heading"]'));
        const buttons = [...root.querySelectorAll(interactiveSelector)]
          .filter(visible)
          .map((el) => ({ text: textOf(el) }))
          .filter((entry) => entry.text);
        const moreOptions = buttons.find((entry) => entry.text === '更多选项') || null;
        const actionButtons = buttons.filter((entry) => actionPattern.test(entry.text));
        const table = root.querySelector('[role="table"],[role="grid"],table');
        const text = textOf(root);
        let score = 0;
        if (heading) score += 4;
        if (table) score += 4;
        if (moreOptions) score += 8;
        if (actionButtons.length) score += 8;
        if (/随机播放|播放列表|网易云音乐|QQ音乐/.test(text)) score += 3;
        return {
          heading,
          hasMoreOptions: Boolean(moreOptions),
          actionButtons: actionButtons.map((entry) => entry.text).slice(0, 10),
          score,
          textPreview: text.slice(0, 240),
        };
      };

      const detail = roots
        .map(summarizeRoot)
        .filter((entry) => entry.hasMoreOptions || entry.actionButtons.length > 0)
        .sort((left, right) => right.score - left.score)[0] || null;

      const visibleMenuItems = [...document.querySelectorAll(interactiveSelector)]
        .filter(visible)
        .map((el) => textOf(el))
        .filter((text) => actionPattern.test(text))
        .slice(0, 20);

      return {
        ok: true,
        detailFound: Boolean(detail),
        detailHeading: detail?.heading || null,
        detailHasMoreOptions: Boolean(detail?.hasMoreOptions),
        detailButtons: detail?.actionButtons || [],
        visibleMenuItems,
        bodyPreview: normalize(main.innerText || '').slice(0, 400),
      };
    }`
  );
  return result?.result || result || {};
}

function clickDetailMoreOptions(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute?.('aria-label') || el?.textContent || '');
      const interactiveSelector = 'button,[role="button"],a,[role="link"]';
      const main = document.querySelector('main') || document.body;
      const roots = [...main.querySelectorAll('main > div, main > section, main > article, main > [role="region"], main > [role="group"], main > *')]
        .filter(visible);
      const candidates = roots.map((root) => {
        const heading = textOf(root.querySelector('h1,h2,h3,h4,[role="heading"]'));
        const buttons = [...root.querySelectorAll(interactiveSelector)].filter(visible);
        const moreButton = buttons.find((el) => textOf(el) === '更多选项') || null;
        const text = textOf(root);
        const table = root.querySelector('[role="table"],[role="grid"],table');
        let score = 0;
        if (heading) score += 4;
        if (table) score += 4;
        if (moreButton) score += 10;
        if (/随机播放|播放列表|网易云音乐|QQ音乐/.test(text)) score += 3;
        return {
          heading,
          moreButton,
          score,
          textPreview: text.slice(0, 240),
        };
      }).filter((entry) => entry.moreButton).sort((left, right) => right.score - left.score);
      const best = candidates[0] || null;
      if (!best?.moreButton) {
        return {
          ok: false,
          reason: 'detail-more-options-not-found',
          visibleButtons: [...document.querySelectorAll(interactiveSelector)]
            .filter(visible)
            .map((el) => textOf(el))
            .filter(Boolean)
            .slice(0, 40),
        };
      }
      best.moreButton.click();
      return {
        ok: true,
        clicked: '更多选项',
        detailHeading: best.heading || null,
        detailPreview: best.textPreview,
      };
    }`
  );
  return result?.result || result || {};
}

function waitForPlaybackActions(runner, targetId, preferredLabels, { timeoutMs = 2200, intervalMs = 180 } = {}) {
  const wanted = preferredLabels.map((label) => normalizeMenuLabel(label));
  if (typeof runner.waitForCondition !== 'function') {
    const surface = inspectPlaybackActionSurface(runner, targetId);
    const availableActions = surface?.visibleMenuItems || [];
    const normalizedAvailable = availableActions.map((label) => normalizeMenuLabel(label));
    return {
      ok: normalizedAvailable.some((label) => wanted.includes(label)),
      result: {
        availableActions,
        surface,
      },
    };
  }

  return runner.waitForCondition(
    'playback-actions-visible',
    () => {
      const surface = inspectPlaybackActionSurface(runner, targetId);
      const availableActions = surface?.visibleMenuItems || [];
      const normalizedAvailable = availableActions.map((label) => normalizeMenuLabel(label));
      return {
        ok: normalizedAvailable.some((label) => wanted.includes(label)),
        availableActions,
        surface,
      };
    },
    {
      timeoutMs,
      intervalMs,
      ready: (value) => Boolean(value?.ok),
    }
  );
}

export function openPlaybackActionMenu(runner, targetId, { preferredLabels = ['替换队列', '立即播放'], waitMs = 350 } = {}) {
  const before = inspectPlaybackActionSurface(runner, targetId);
  const wanted = preferredLabels.map((label) => normalizeMenuLabel(label));
  const beforeActions = (before?.visibleMenuItems || []).map((label) => normalizeMenuLabel(label));
  if (beforeActions.some((label) => wanted.includes(label))) {
    return {
      ok: true,
      menuAlreadyOpen: true,
      clickedMoreOptions: false,
      detailHeading: before?.detailHeading || null,
      availableActions: before?.visibleMenuItems || [],
      surface: before,
    };
  }

  if (!before?.detailHasMoreOptions) {
    throw new SkillError(
      'browser-action',
      'PLAYBACK_MENU_ENTRY_NOT_FOUND',
      'Could not find the detail-page 更多选项 entry before attempting playback.',
      { targetId, surface: before }
    );
  }

  const clickResult = clickDetailMoreOptions(runner, targetId);
  if (!clickResult?.ok) {
    throw new SkillError(
      'browser-action',
      'PLAYBACK_MENU_OPEN_FAILED',
      'Failed to click the detail-page 更多选项 control.',
      { targetId, clickResult, surface: before }
    );
  }

  const waited = waitForPlaybackActions(runner, targetId, preferredLabels, { timeoutMs: Math.max(waitMs * 6, 1200) });
  if (!waited?.ok) runner.waitMs(waitMs);
  const after = waited?.result?.surface || inspectPlaybackActionSurface(runner, targetId);
  const availableActions = waited?.result?.availableActions || after?.visibleMenuItems || [];
  const normalizedAvailable = availableActions.map((label) => normalizeMenuLabel(label));
  if (!normalizedAvailable.some((label) => wanted.includes(label))) {
    throw new SkillError(
      'browser-action',
      'PLAYBACK_MENU_ACTIONS_NOT_VISIBLE',
      'Opened 更多选项, but the expected playback actions did not become visible.',
      { targetId, preferredLabels, before, after, clickResult }
    );
  }

  return {
    ok: true,
    menuAlreadyOpen: false,
    clickedMoreOptions: true,
    detailHeading: after?.detailHeading || clickResult?.detailHeading || null,
      availableActions,
      surface: after,
      waited,
    };
  }

export function choosePlaybackAction(runner, targetId, labels = ['替换队列', '立即播放'], options = {}) {
  const menuState = openPlaybackActionMenu(runner, targetId, { preferredLabels: labels, ...options });
  const normalizedChoices = labels.map((label) => normalizeMenuLabel(label));
  const visibleActions = Array.isArray(menuState?.availableActions) ? menuState.availableActions : [];
  const actualLabel = normalizedChoices
    .map((wanted) => visibleActions.find((label) => normalizeMenuLabel(label) === wanted))
    .find(Boolean);

  if (!actualLabel) {
    throw new SkillError(
      'browser-action',
      'PLAYBACK_ACTION_NOT_FOUND',
      'The requested playback action is not visible in the Sonos action menu.',
      { targetId, labels, menuState }
    );
  }

  const clickResult = clickButtonByLabel(runner, targetId, [actualLabel]);
  if (!clickResult?.ok) {
    throw new SkillError(
      'browser-action',
      'PLAYBACK_ACTION_CLICK_FAILED',
      'Failed to click the chosen Sonos playback action.',
      { targetId, labels, actualLabel, clickResult, menuState }
    );
  }

  const waitMs = options.waitMs ?? 350;
  const postClickWait = typeof runner.waitForCondition === 'function'
    ? runner.waitForCondition(
        'playback-action-transition',
        () => {
          const surface = inspectPlaybackActionSurface(runner, targetId) || {};
          const visibleMenuItems = surface?.visibleMenuItems || [];
          const stillVisible = visibleMenuItems.some((label) => normalizeMenuLabel(label) === normalizeMenuLabel(actualLabel));
          return {
            ok: !stillVisible,
            visibleMenuItems,
            surface,
            stillVisible,
          };
        },
        {
          timeoutMs: Math.max(waitMs * 8, 1400),
          intervalMs: 180,
          ready: (value) => Boolean(value?.ok),
        }
      )
    : null;
  if (!postClickWait) runner.waitMs(waitMs);
  const postClickVisibleMenuItems = postClickWait?.result?.visibleMenuItems || inspectPlaybackActionSurface(runner, targetId)?.visibleMenuItems || [];
  return {
    ok: true,
    requestedLabels: labels,
    actualLabel,
    normalizedAction: normalizeMenuLabel(actualLabel),
    menuState,
    postClickVisibleMenuItems,
    postClickWait,
  };
}
