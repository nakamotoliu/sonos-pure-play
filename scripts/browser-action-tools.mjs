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
      const playGroupLabel = '播放群组' + targetRoom;
      const pauseGroupLabel = '暂停群组' + targetRoom;
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const interactiveSelector = 'button,[role="button"],a,[role="link"]';
      const systemViewTokens = ['系统视图', '您的系统', 'your system', 'system view'];
      const controlsOf = (root) => root
        ? [...root.querySelectorAll(interactiveSelector)].filter(visible)
        : [];
      const labelsOf = (root) => controlsOf(root).map((el) => textOf(el)).filter(Boolean);
      const scoreSystemRoot = (root) => {
        const name = normalize(root?.getAttribute?.('aria-label') || root?.getAttribute?.('data-testid') || '');
        const labels = labelsOf(root);
        const text = normalize(root?.innerText || '');
        let score = 0;
        if (systemViewTokens.some((token) => name.includes(token) || text.includes(token))) score += 80;
        if (labels.includes(exactActivateLabel) || labels.includes(playGroupLabel) || labels.includes(pauseGroupLabel)) score += 40;
        if (text.includes(targetRoom)) score += 12;
        score += labels.filter((label) => /^将.+设置为有效$/.test(label)).length * 12;
        score += labels.filter((label) => /^播放群组/.test(label) || /^暂停群组/.test(label)).length * 10;
        score += labels.filter((label) => label === '输出选择器').length * 6;
        return { root, score, labels, text };
      };
      const explicitRoots = [...document.querySelectorAll('[role="region"],section,aside')].filter(visible);
      const implicitRoots = [...document.querySelectorAll('div')]
        .filter(visible)
        .filter((el) => {
          const labels = labelsOf(el);
          return labels.length >= 4 && labels.some((label) => /设置为有效|播放群组|暂停群组|输出选择器/.test(label));
        })
        .slice(0, 80);
      const systemRootCandidate = [...new Set([...explicitRoots, ...implicitRoots])]
        .map(scoreSystemRoot)
        .sort((a, b) => b.score - a.score)[0] || null;
      const systemRoot = systemRootCandidate?.score > 0 ? systemRootCandidate.root : null;
      if (!systemRoot) {
        return { ok: false, reason: 'room-system-view-not-found', exactActivateLabel };
      }

      const roomControlPattern = /^(将.+设置为有效|播放群组.+|暂停群组.+)$/;
      const labelsMentioningOtherRooms = (labels) => labels
        .filter((label) => roomControlPattern.test(label))
        .filter((label) => !label.includes(targetRoom));
      const isMixedRoomCard = (labels) => labelsMentioningOtherRooms(labels).length > 0;
      const scoreCard = (card) => {
        const labels = labelsOf(card);
        const text = textOf(card);
        const rect = card.getBoundingClientRect();
        const mixedRoomCard = isMixedRoomCard(labels);
        let score = 0;
        if (text.includes(targetRoom)) score += 20;
        if (labels.includes(exactActivateLabel)) score += 25;
        if (labels.includes(playGroupLabel) || labels.includes(pauseGroupLabel)) score += 18;
        if (labels.includes('输出选择器')) score += 10;
        if (mixedRoomCard) score -= 1000;
        return { card, labels, text, rect, score, mixedRoomCard };
      };

      const cardRootOf = (node) => {
        if (!node) return null;
        let best = null;
        for (let current = node; current && current !== systemRoot && current !== document.body; current = current.parentElement) {
          if (!visible(current)) continue;
          const text = textOf(current);
          if (!text.includes(targetRoom)) continue;
          const labels = labelsOf(current);
          if (!labels.some((label) => label === exactActivateLabel || label === playGroupLabel || label === pauseGroupLabel || label === '输出选择器')) continue;
          if (isMixedRoomCard(labels)) continue;
          best = current;
        }
        return best;
      };

      const anchorControls = controlsOf(systemRoot).filter((el) => {
        const label = textOf(el);
        return label === exactActivateLabel || label === playGroupLabel || label === pauseGroupLabel || label.includes(targetRoom);
      });
      let candidateCards = [...new Set(anchorControls.map((el) => cardRootOf(el)).filter(Boolean))]
        .map(scoreCard)
        .filter((entry) => !entry.mixedRoomCard)
        .sort((a, b) => b.score - a.score);

      if (!candidateCards.length) {
        candidateCards = [...systemRoot.querySelectorAll('div,section,article,li,[role="group"],[role="listitem"]')]
          .filter(visible)
          .filter((el) => {
            const text = textOf(el);
            if (!text.includes(targetRoom)) return false;
            const labels = labelsOf(el);
            if (isMixedRoomCard(labels)) return false;
            return labels.some((label) => label === exactActivateLabel || label === playGroupLabel || label === pauseGroupLabel || label === '输出选择器');
          })
          .map(scoreCard)
          .filter((entry) => !entry.mixedRoomCard)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
      }

      const best = candidateCards[0] || null;
      if (!best) return { ok: false, reason: 'room-card-not-found', exactActivateLabel, systemViewButtons: systemRootCandidate?.labels?.slice(0, 24) || [] };
      const buttons = controlsOf(best.card);
      const labels = best.labels;
      const targetButton = buttons.find((el) => textOf(el) === exactActivateLabel) || null;
      if (!targetButton) {
        return {
          ok: true,
          skipped: true,
          reason: 'target-room-already-active',
          exactActivateLabel,
          roomCardButtons: labels.slice(0, 20),
          roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
        };
      }
      targetButton.click();
      return {
        ok: true,
        skipped: false,
        clicked: exactActivateLabel,
        roomCardButtons: labels.slice(0, 20),
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

function waitForPlaybackActions(runner, targetId, preferredLabels, { timeoutMs = 1200, intervalMs = 120 } = {}) {
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

export function openPlaybackActionMenu(runner, targetId, { preferredLabels = ['替换队列', '立即播放'], waitMs = 200 } = {}) {
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

  const waited = waitForPlaybackActions(runner, targetId, preferredLabels, { timeoutMs: Math.max(waitMs * 4, 800) });
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

  const waitMs = options.waitMs ?? 200;
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
          timeoutMs: Math.max(waitMs * 4, 800),
          intervalMs: 120,
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
