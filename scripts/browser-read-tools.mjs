import { execFileSync } from 'node:child_process';
import { buildReadLayeredPageStateFn } from './dom-layers.mjs';
import { classifyRoomActiveState } from './room-active-detector.mjs';

export function evaluate(runner, targetId, fnSource) {
  const resident = runner.actBrowser?.({ kind: 'evaluate', targetId, fn: fnSource }, { timeoutMs: runner.browserCommandTimeoutMs || 90000 });
  if (resident) return resident;
  return runner.oc(['evaluate', '--target-id', targetId, '--fn', fnSource]);
}

export function snapshot(runner, targetId, limit = 260) {
  const resident = runner.requestBrowser?.({
    method: 'GET',
    path: '/snapshot',
    query: { format: 'aria', targetId, limit },
  }, { timeoutMs: 20000 });
  if (resident) return resident;
  const shot = runner.oc(['snapshot', '--target-id', targetId, '--format', 'aria', '--limit', String(limit)]);
  return shot;
}

export function snapshotAi(runner, targetId, limit = 260) {
  const resident = runner.requestBrowser?.({
    method: 'GET',
    path: '/snapshot',
    query: { format: 'ai', targetId, limit },
  }, { timeoutMs: 20000 });
  if (resident) return resident;
  return runner.oc(['snapshot', '--target-id', targetId, '--limit', String(limit)]);
}

export function screenshotRoot(runner, targetId) {
  try {
    const raw = execFileSync(
      'openclaw',
      ['browser', '--browser-profile', runner.profile, 'screenshot', targetId],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      }
    );
    const text = String(raw || '').trim();
    const match = text.match(/MEDIA:(.+)$/m);
    return {
      ok: !!match,
      mediaPath: match ? match[1].trim() : null,
      raw: text,
    };
  } catch (error) {
    return {
      ok: false,
      mediaPath: null,
      error: String(error?.stderr || error?.stdout || error?.message || error),
    };
  }
}

export function readPageState(runner, targetId) {
  const result = evaluate(runner, targetId, buildReadLayeredPageStateFn());
  return result?.result || result || {};
}

export function readVisibleMenuItems(runner, targetId) {
  const result = evaluate(
    runner,
    targetId,
    `() => {
      const items = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],li')]
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter((text) => /替换当前歌单|替换播放列表|替换队列|立即播放|添加到队列末尾/.test(text));
      return items;
    }`
  );
  return result?.result || result || [];
}

export function readRoomContext(runner, targetId) {
  const result = evaluate(
    runner,
    targetId,
    `() => {
      const texts = [...document.querySelectorAll('button,[role="button"],li,div,span')]
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter(Boolean);
      const roomItems = texts.filter((text) =>
        /设置为有效|播放群组|暂停群组|客厅|工作室|卧室|厨房|书房/.test(text)
      );
      return {
        url: location.href,
        title: document.title || '',
        roomItems: roomItems.slice(0, 80),
      };
    }`
  );
  return result?.result || result || { roomItems: [] };
}

export function readRoomSyncState(runner, targetId, room) {
  const result = evaluate(
    runner,
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
      const roomSignalPattern = /设置为有效|播放群组|暂停群组|输出选择器/;
      const systemViewTokens = ['系统视图', '您的系统', 'your system', 'system view'];
      const controlsOf = (root) => root
        ? [...root.querySelectorAll(interactiveSelector)].filter(visible)
        : [];
      const labelsOf = (root) => controlsOf(root).map((el) => textOf(el)).filter(Boolean);
      const scoreSystemRoot = (root) => {
        const name = normalize(root?.getAttribute?.('aria-label') || root?.getAttribute?.('data-testid') || '');
        const buttons = labelsOf(root);
        const text = normalize(root?.innerText || '');
        const activateCount = buttons.filter((label) => /^将.+设置为有效$/.test(label)).length;
        const groupCount = buttons.filter((label) => /^播放群组/.test(label) || /^暂停群组/.test(label)).length;
        const outputCount = buttons.filter((label) => label === '输出选择器').length;
        let score = 0;
        if (systemViewTokens.some((token) => name.includes(token) || text.includes(token))) score += 80;
        if (buttons.includes(exactActivateLabel) || buttons.includes(playGroupLabel) || buttons.includes(pauseGroupLabel)) score += 40;
        if (text.includes(targetRoom)) score += 12;
        score += activateCount * 12;
        score += groupCount * 10;
        score += outputCount * 6;
        return {
          root,
          score,
          name,
          buttons,
          textPreview: text.slice(0, 320),
        };
      };
      const explicitRoots = [...document.querySelectorAll('[role="region"],section,aside')].filter(visible);
      const implicitRoots = [...document.querySelectorAll('div')]
        .filter(visible)
        .filter((el) => {
          const buttons = labelsOf(el);
          return buttons.length >= 4 && buttons.some((label) => roomSignalPattern.test(label));
        })
        .slice(0, 80);
      const systemRootCandidate = [...new Set([...explicitRoots, ...implicitRoots])]
        .map(scoreSystemRoot)
        .sort((a, b) => b.score - a.score)[0] || null;
      const systemRoot = systemRootCandidate?.score > 0 ? systemRootCandidate.root : null;

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
        if (/音量|静音/.test(text)) score += 4;
        if (mixedRoomCard) score -= 1000;
        return {
          card,
          labels,
          text,
          rect,
          score,
          mixedRoomCard,
        };
      };

      const cardRootOf = (node) => {
        if (!node || !systemRoot) return null;
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

      const anchorNodes = systemRoot
        ? controlsOf(systemRoot).filter((el) => {
            const label = textOf(el);
            return label === exactActivateLabel || label === playGroupLabel || label === pauseGroupLabel || label.includes(targetRoom);
          })
        : [];

      let cardCandidates = [...new Set(anchorNodes.map((el) => cardRootOf(el)).filter(Boolean))]
        .map(scoreCard)
        .filter((entry) => !entry.mixedRoomCard)
        .sort((a, b) => b.score - a.score);

      if (!cardCandidates.length && systemRoot) {
        cardCandidates = [...systemRoot.querySelectorAll('div,section,article,li,[role="group"],[role="listitem"]')]
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

      const best = cardCandidates[0] || null;
      const roomCardButtons = best?.labels || [];
      const roomCardText = best?.text ? best.text.slice(0, 320) : null;
      const fallbackText = normalize((systemRoot || document.querySelector('main') || document.body)?.innerText || '');
      const nowPlayingSection = [...document.querySelectorAll('[role="region"],section,div')]
        .filter(visible)
        .find((el) => normalize(el.getAttribute('aria-label') || '') === '正在播放' || normalize(el.textContent || '').startsWith('正在播放'));
      const nowPlayingText = normalize(nowPlayingSection?.innerText || nowPlayingSection?.textContent || '');

      return {
        targetRoom,
        exactActivateLabel,
        systemViewFound: Boolean(systemRoot),
        systemViewScore: systemRootCandidate?.score || 0,
        systemViewButtons: systemRootCandidate?.buttons?.slice(0, 24) || [],
        roomVisible: Boolean(best || fallbackText.includes(targetRoom)),
        roomCardFound: Boolean(best),
        roomCardRect: best
          ? { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) }
          : null,
        roomCardText,
        roomCardButtons: roomCardButtons.slice(0, 20),
        activeStateInput: { room: targetRoom, labels: roomCardButtons, text: roomCardText || '', nowPlayingText },
        pageNowPlayingText: nowPlayingText.slice(0, 320),
        url: location.href,
        title: document.title || '',
        bodyPreview: fallbackText.slice(0, 800),
      };
    }`
  );
  const state = result?.result || result || { targetRoom: room, activeRoomConfirmed: false };
  const activeState = classifyRoomActiveState(state.activeStateInput || {
    room: state.targetRoom || room,
    labels: state.roomCardButtons || [],
    text: state.roomCardText || '',
    nowPlayingText: state.pageNowPlayingText || '',
  });
  return {
    ...state,
    activeControls: activeState.activeControls,
    activeRoomConfirmed: activeState.activeRoomConfirmed,
    activeRoomReason: activeState.reason,
    nowPlayingVisible: activeState.activeRoomConfirmed,
    nowPlayingText: activeState.activeRoomConfirmed ? (state.roomCardText || state.targetRoom || room || '').slice(0, 220) : '',
    nowPlayingRoom: activeState.activeRoomConfirmed ? (state.targetRoom || room) : null,
  };
}
