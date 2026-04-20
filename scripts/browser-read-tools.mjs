import { execFileSync } from 'node:child_process';
import { buildReadLayeredPageStateFn } from './dom-layers.mjs';

export function evaluate(runner, targetId, fnSource) {
  return runner.oc(['evaluate', '--target-id', targetId, '--fn', fnSource]);
}

export function snapshot(runner, targetId, limit = 260) {
  const shot = runner.oc(['snapshot', '--target-id', targetId, '--format', 'aria', '--limit', String(limit)]);
  return shot;
}

export function snapshotAi(runner, targetId, limit = 260) {
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
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const mentionNodes = [...document.querySelectorAll('button,[role="button"],a,[role="link"],li,article,section,div,span')]
        .filter(visible)
        .filter((el) => textOf(el).includes(targetRoom));
      const hasRoomControlSignals = (node) => {
        const labels = [...node.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .filter(visible)
          .map((entry) => textOf(entry))
          .filter(Boolean);
        return labels.includes(exactActivateLabel)
          || labels.includes('输出选择器')
          || labels.some((label) => label === '暂停群组' + targetRoom || label === '播放群组' + targetRoom);
      };
      const isDetailLike = (node) => {
        const txt = textOf(node);
        return !!node.querySelector('[role="table"],[role="grid"],table')
          || /标题 时间|随机播放|更多选项|网易云音乐|播放列表/.test(txt);
      };
      const cardRootOf = (el) => {
        if (!el) return null;
        let best = null;
        for (let current = el, depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const txt = textOf(current);
          if (!txt.includes(targetRoom)) continue;
          if (isDetailLike(current)) continue;
          if (hasRoomControlSignals(current)) {
            best = current;
            break;
          }
          if (!best && /设置为有效|输出选择器|播放群组|暂停群组/.test(txt)) {
            best = current;
          }
        }
        return best;
      };
      const candidateCards = [...new Set(mentionNodes.map((el) => cardRootOf(el)).filter(Boolean))];
      const cardSummaries = candidateCards.map((card, index) => {
        const text = textOf(card);
        const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .filter(visible)
          .map((el) => textOf(el))
          .filter(Boolean);
        const rect = card.getBoundingClientRect();
        const activateLabels = buttons.filter((label) => /^将.+设置为有效$/.test(label));
        const score = (text.includes(targetRoom) ? 10 : 0)
          + (buttons.includes(exactActivateLabel) ? 20 : 0)
          + (buttons.includes('输出选择器') ? 5 : 0)
          + (buttons.some((label) => label === '暂停群组' + targetRoom || label === '播放群组' + targetRoom) ? 8 : 0)
          - (activateLabels.length > 1 ? 30 : 0);
        return {
          index,
          text,
          buttons,
          activateLabels,
          score,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      }).filter((entry) => entry.activateLabels.length <= 1).sort((a, b) => b.score - a.score);

      const best = cardSummaries[0] || null;
      const bodyText = normalize(document.body?.innerText || '');
      const activeControls = best?.buttons.filter((label) =>
        label === '输出选择器' ||
        label === '暂停群组' + targetRoom ||
        label === '播放群组' + targetRoom
      ) || [];
      const nowPlayingSection = [...document.querySelectorAll('section,[role="region"],div')]
        .filter(visible)
        .find((el) => (el.getAttribute('aria-label') || '') === '正在播放' || /^正在播放$/.test(textOf(el)));
      const nowPlayingScope = nowPlayingSection?.parentElement || nowPlayingSection || null;
      const nowPlayingText = nowPlayingScope ? textOf(nowPlayingScope) : '';
      const nowPlayingRoom = nowPlayingText.includes(targetRoom) ? targetRoom : null;

      return {
        targetRoom,
        exactActivateLabel,
        roomVisible: bodyText.includes(targetRoom),
        roomCardFound: !!best,
        roomCardRect: best?.rect || null,
        roomCardText: best?.text?.slice(0, 260) || null,
        roomCardButtons: best?.buttons?.slice(0, 20) || [],
        activeControls,
        activeRoomConfirmed: !!nowPlayingRoom,
        nowPlayingVisible: !!nowPlayingSection,
        nowPlayingText: nowPlayingText.slice(0, 220),
        nowPlayingRoom,
        url: location.href,
        title: document.title || '',
        bodyPreview: bodyText.slice(0, 800),
      };
    }`
  );
  return result?.result || result || { targetRoom: room, activeRoomConfirmed: false };
}
