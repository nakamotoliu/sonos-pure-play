/**
 * browser-runner.mjs — Browser automation for Sonos Pure Play.
 *
 * Uses the official `openclaw browser` CLI/runtime instead of a custom CDP
 * bridge. API surface is kept compatible so web-flow.mjs / run.mjs remain
 * unchanged.
 */

import { execFileSync } from 'node:child_process';

import { SkillError } from './normalize.mjs';
import { SEARCH_URL, SONOS_HOST } from './selectors.mjs';
import { buildReadLayeredPageStateFn } from './dom-layers.mjs';

export class PurePlayBrowserRunner {
  constructor({ profile = 'user', logger = () => {}, baseUrl = SEARCH_URL } = {}) {
    this.profile = profile;
    this.logger = logger;
    this.baseUrl = baseUrl;
  }

  log(event) {
    this.logger({ ok: true, phase: 'browser-runner', ...event });
  }

  /**
   * Execute an `openclaw browser` command synchronously.
   */
  oc(args, { parseJson = true } = {}) {
    try {
      const base = ['browser', '--browser-profile', this.profile, '--json', ...args];
      const raw = execFileSync('openclaw', base, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });
      if (!parseJson) return raw;
      const trimmed = String(raw || '').trim();
      try {
        return JSON.parse(trimmed);
      } catch {
        const start = trimmed.indexOf('{');
        if (start >= 0) return JSON.parse(trimmed.slice(start));
        throw new Error(`No JSON payload found in output: ${trimmed.slice(0, 400)}`);
      }
    } catch (error) {
      const stderr = String(error?.stderr || error?.message || error);
      const stdout = String(error?.stdout || '');
      throw new SkillError(
        'browser-runner',
        'BROWSER_ATTACH_FAILED',
        `${stderr || stdout}`.trim(),
        { args, profile: this.profile }
      );
    }
  }

  tabs() {
    return this.oc(['tabs']).tabs || [];
  }

  focus(targetId) {
    this.oc(['focus', targetId], { parseJson: false });
  }

  close(targetId) {
    this.oc(['close', targetId], { parseJson: false });
  }

  waitMs(ms) {
    this.oc(['wait', '--time', String(ms)], { parseJson: false });
  }

  waitForLoad(targetId) {
    this.oc(['wait', '--target-id', targetId, '--load', 'domcontentloaded', '--timeout-ms', '30000'], { parseJson: false });
  }

  navigate(targetId, url) {
    this.oc(['navigate', url, '--target-id', targetId], { parseJson: false });
  }

  press(targetId, key) {
    this.oc(['press', key, '--target-id', targetId], { parseJson: false });
  }

  click(targetId, ref) {
    this.oc(['click', ref, '--target-id', targetId], { parseJson: false });
  }

  start() {
    this.oc(['start'], { parseJson: false });
  }

  clickButtonByLabel(targetId, labels = []) {
    const result = this.evaluate(
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

  snapshot(targetId, limit = 260) {
    const snapshot = this.oc(['snapshot', '--target-id', targetId, '--format', 'aria', '--limit', String(limit)]);
    if (!snapshot?.ok || !Array.isArray(snapshot.nodes)) {
      throw new SkillError('snapshot', 'SNAPSHOT_FAILED', 'Failed to capture Sonos snapshot.', { targetId });
    }
    return snapshot;
  }

  evaluate(targetId, fnSource) {
    return this.oc(['evaluate', '--target-id', targetId, '--fn', fnSource]);
  }

  ensureSonosTab() {
    this.start();

    let sonosTabs = this.tabs().filter((entry) => String(entry.url || '').includes(SONOS_HOST));

    if (sonosTabs.length > 1) {
      const keepTab = sonosTabs[sonosTabs.length - 1];
      const closeTabs = sonosTabs.slice(0, -1);
      const closedTargetIds = [];

      for (const entry of closeTabs) {
        if (!entry?.targetId) continue;
        this.close(entry.targetId);
        closedTargetIds.push(entry.targetId);
        this.log({ event: 'tab-closed', targetId: entry.targetId, url: entry.url || null });
      }

      this.log({
        event: 'tab-hygiene',
        foundSonosTabs: sonosTabs.length,
        keptTargetId: keepTab?.targetId || null,
        keptUrl: keepTab?.url || null,
        closedTargetIds,
      });

      this.waitMs(1000);
      sonosTabs = this.tabs().filter((entry) => String(entry.url || '').includes(SONOS_HOST));
    }

    let tab = sonosTabs[sonosTabs.length - 1];

    if (!tab) {
      this.oc(['open', SEARCH_URL], { parseJson: false });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        this.waitMs(1000);
        sonosTabs = this.tabs().filter((entry) => String(entry.url || '').includes(SONOS_HOST));
        tab = sonosTabs[sonosTabs.length - 1];
        if (tab?.targetId) break;
      }
    }

    if (!tab?.targetId) {
      throw new SkillError(
        'browser-runner',
        'SONOS_WEB_NOT_READY',
        'Unable to find or open the Sonos Web App in Chrome.'
      );
    }

    this.focus(tab.targetId);
    this.waitMs(2000);
    this.waitForLoad(tab.targetId);
    this.waitMs(3000);
    this.log({ event: 'tab-ready', targetId: tab.targetId, url: tab.url || null, foregroundRequired: true, profile: this.profile });
    return tab.targetId;
  }

  readPageState(targetId) {
    const result = this.evaluate(targetId, buildReadLayeredPageStateFn());
    const state = result?.result || result || {};
    const detail = Array.isArray(state?.layers?.detail) ? state.layers.detail : [];
    const roomCards = Array.isArray(state?.layers?.roomCards) ? state.layers.roomCards : [];
    const search = Array.isArray(state?.layers?.search) ? state.layers.search : [];
    const searchText = search.join(' ');
    const pageKind = state?.appError
      ? 'APP_ERROR'
      : state?.bootstrapBlank
        ? 'BOOTSTRAP_BLANK'
        : detail.some((entry) => entry?.rows?.length && entry?.buttons?.some((b) => b === '更多选项'))
          ? 'PLAYLIST_DETAIL_READY'
          : roomCards.length > 0
            ? 'ROOM_PANEL'
            : /搜索记录/.test(searchText)
              ? 'SEARCH_HISTORY'
              : /最近播放|您的服务|Sonos收藏夹|您的信号源|线路输入/.test(searchText)
                ? 'SEARCH_SHELL_DIRTY'
                : search.length > 0
                  ? 'SEARCH_RESULTS_MIXED'
                  : String(state?.url || '').includes('/search')
                    ? 'SEARCH_READY'
                    : String(state?.url || '').includes('/web-app')
                      ? 'APP_HOME'
                      : 'UNKNOWN';
    return {
      ...state,
      pageKind,
      visibleMoreOptions: detail.flatMap((entry) => (entry?.buttons || []).filter((label) => label === '更多选项').map((label) => ({ label, zone: 'detail' }))),
      bodyPreview: searchText.slice(0, 800),
    };
  }

  readVisibleMenuItems(targetId) {
    const result = this.evaluate(
      targetId,
      `() => [...document.querySelectorAll('button,[role="button"],[role="menuitem"],li')]
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter((text) => /替换当前歌单|替换播放列表|替换队列|立即播放|添加到队列末尾/.test(text))`
    );
    return result?.result || result || [];
  }

  readRoomSyncState(targetId, room) {
    const result = this.evaluate(
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

        const roomActivateLabels = (buttons) => buttons.filter((label) => /^将.+设置为有效$/.test(label));
        const cardSummaries = candidateCards.map((card, index) => {
          const text = textOf(card);
          const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')]
            .filter(visible)
            .map((el) => textOf(el))
            .filter(Boolean);
          const rect = card.getBoundingClientRect();
          const activateLabels = roomActivateLabels(buttons);
          const score = (text.includes(targetRoom) ? 10 : 0)
            + (buttons.includes(exactActivateLabel) ? 20 : 0)
            + (buttons.some((label) => label === '输出选择器') ? 5 : 0)
            + (buttons.some((label) => label === '暂停群组' + targetRoom || label === '播放群组' + targetRoom) ? 8 : 0)
            - (activateLabels.length > 1 ? 30 : 0)
            - (rect.y > window.innerHeight ? 4 : 0);
          return {
            index,
            card,
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
        const activateButtonVisible = !!best?.buttons.includes(exactActivateLabel);
        const nowPlayingSection = [...document.querySelectorAll('section,[role="region"],div')]
          .filter(visible)
          .find((el) => (el.getAttribute('aria-label') || '') === '正在播放' || /^正在播放$/.test(textOf(el)));
        const nowPlayingScope = nowPlayingSection?.parentElement || nowPlayingSection || null;
        const nowPlayingText = nowPlayingScope ? textOf(nowPlayingScope) : '';
        const nowPlayingRoom = nowPlayingText.includes(targetRoom) ? targetRoom : null;
        const targetAlreadyActive = !!nowPlayingRoom;
        const activeRoomConfirmed = !!nowPlayingRoom;
        const confirmSignals = [];
        if (best) confirmSignals.push('room-card-found');
        if (bodyText.includes(targetRoom)) confirmSignals.push('room-mentioned-on-page');
        if (activateButtonVisible) confirmSignals.push('activate-button-visible-in-card');
        if (!activateButtonVisible && best) confirmSignals.push('activate-button-hidden-in-card');
        if (activeControls.length) confirmSignals.push('card-active-controls:' + activeControls.join('|'));
        if (nowPlayingSection) confirmSignals.push('now-playing-visible');
        if (nowPlayingRoom) confirmSignals.push('now-playing-room-matched');
        if (targetAlreadyActive) confirmSignals.push('target-room-already-active');

        return {
          targetRoom,
          exactActivateLabel,
          roomVisible: bodyText.includes(targetRoom),
          roomCardFound: !!best,
          roomCardRect: best?.rect || null,
          roomCardText: best?.text?.slice(0, 260) || null,
          roomCardButtons: best?.buttons?.slice(0, 20) || [],
          roomCardSamples: cardSummaries.slice(0, 5).map((entry) => entry.text.slice(0, 220)),
          activateButtonVisible,
          activateButtonText: activateButtonVisible ? exactActivateLabel : null,
          activeControls,
          confirmSignals,
          roomCardHasOutputControls: activeControls.length > 0,
          targetAlreadyActive,
          activeRoomConfirmed,
          nowPlayingVisible: !!nowPlayingSection,
          nowPlayingText: nowPlayingText.slice(0, 220),
          nowPlayingRoom,
          url: location.href,
          title: document.title || '',
          bodyPreview: bodyText.slice(0, 800),
        };
      }`
    );
    return result?.result || result || {
      targetRoom: room,
      activeRoomConfirmed: false,
      targetAlreadyActive: false,
      activateButtonVisible: false,
      roomVisible: false,
      roomCardFound: false,
      roomCardSamples: [],
      roomCardButtons: [],
      activeControls: [],
      confirmSignals: [],
      nowPlayingVisible: false,
      nowPlayingText: '',
      nowPlayingRoom: null,
    };
  }

  clickRoomActivate(targetId, room) {
    const result = this.evaluate(
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
        const scored = candidateCards.map((card) => {
          const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')]
            .filter(visible);
          const labels = buttons.map((el) => textOf(el)).filter(Boolean);
          const activateLabels = labels.filter((label) => /^将.+设置为有效$/.test(label));
          const targetButton = buttons.find((el) => textOf(el) === exactActivateLabel) || null;
          const rect = card.getBoundingClientRect();
          const score = (textOf(card).includes(targetRoom) ? 10 : 0)
            + (targetButton ? 20 : 0)
            + (labels.includes('输出选择器') ? 5 : 0)
            + (labels.some((label) => label === '暂停群组' + targetRoom || label === '播放群组' + targetRoom) ? 8 : 0)
            - (activateLabels.length > 1 ? 30 : 0)
            - (rect.y > window.innerHeight ? 4 : 0);
          return { card, labels, activateLabels, targetButton, rect, score };
        }).filter((entry) => entry.activateLabels.length <= 1).sort((a, b) => b.score - a.score);

        const best = scored[0] || null;
        if (!best) {
          return { ok: false, reason: 'room-card-not-found', exactActivateLabel };
        }
        const activeControls = best.labels.filter((label) =>
          label === '输出选择器' ||
          label === '暂停群组' + targetRoom ||
          label === '播放群组' + targetRoom
        );
        const targetAlreadyActive = !best.targetButton;
        if (targetAlreadyActive) {
          return {
            ok: true,
            skipped: true,
            reason: 'target-room-already-active',
            exactActivateLabel,
            roomCardButtons: best.labels.slice(0, 20),
            activeControls: activeControls.slice(0, 10),
            roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
          };
        }
        if (!best.targetButton) {
          return {
            ok: false,
            reason: 'room-activate-button-not-found-in-card',
            exactActivateLabel,
            roomCardButtons: best.labels.slice(0, 20),
            activeControls: activeControls.slice(0, 10),
            roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
          };
        }
        const clickButton = (button) => {
          if (!button) return;
          try {
            button.click();
          } catch {}
          const rect = button.getBoundingClientRect();
          const x = rect.left + (rect.width / 2);
          const y = rect.top + (rect.height / 2);
          const fire = (type) => {
            const target = document.elementFromPoint(x, y) || button;
            if (!target) return;
            target.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              view: window,
            }));
          };
          fire('pointerdown');
          fire('mousedown');
          fire('pointerup');
          fire('mouseup');
          fire('click');
        };

        clickButton(best.targetButton);
        return {
          ok: true,
          skipped: false,
          clicked: textOf(best.targetButton),
          clickStrategy: 'button.click+native-mouse-events',
          exactActivateLabel,
          roomCardButtons: best.labels.slice(0, 20),
          activeControls: activeControls.slice(0, 10),
          roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
        };
      }`
    );
    return result?.result || result;
  }

  readRoomContext(targetId) {
    const result = this.evaluate(
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

  screenshotRoot(targetId, ref = 'e1') {
    try {
      const raw = execFileSync(
        'openclaw',
        ['browser', '--browser-profile', this.profile, 'screenshot', targetId, '--ref', ref],
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
}
