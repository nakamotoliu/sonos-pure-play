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

export class PurePlayBrowserRunner {
  constructor({ profile = 'openclaw', logger = () => {}, baseUrl = SEARCH_URL } = {}) {
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
      const raw = execFileSync('openclaw', ['browser', '--json', '--browser-profile', this.profile, ...args], {
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
    let tab = this.tabs().find((entry) => String(entry.url || '').includes(SONOS_HOST));

    if (!tab) {
      this.oc(['open', SEARCH_URL], { parseJson: false });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        this.waitMs(1000);
        tab = this.tabs().find((entry) => String(entry.url || '').includes(SONOS_HOST));
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
    this.log({ event: 'tab-ready', targetId: tab.targetId, url: tab.url || null });
    return tab.targetId;
  }

  readPageState(targetId) {
    const result = this.evaluate(
      targetId,
      `() => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
        const isNowPlaying = (el) => !!el?.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]');
        const isSystemControl = (el) => !!el?.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]');
        const bodyText = normalize(document.body?.innerText || '');
        const url = location.href;
        const title = document.title || '';
        const visibleButtons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
        const main = document.querySelector('main') || document.body;
        const mainText = normalize(main?.innerText || '');
        const searchHistory = /搜索记录/.test(bodyText);
        const searchShellDirty = /最近播放|您的服务|Sonos收藏夹|您的信号源|线路输入/.test(bodyText);
        const isServiceDetailUrl = /\\/browse\\/services\\//.test(url);
        const isPlaylistDetailUrl = /\\/browse\\/services\\/.*\\/playlist\\//.test(url);
        const visibleMoreOptions = visibleButtons
          .filter((el) => textOf(el) === '更多选项')
          .map((el) => ({
            label: textOf(el),
            zone: isNowPlaying(el) ? 'now-playing-bar' : isSystemControl(el) ? 'system-controls' : 'main-content',
          }));
        const pageKind =
          searchHistory ? 'SEARCH_HISTORY' :
          searchShellDirty ? 'SEARCH_SHELL_DIRTY' :
          url.includes('/search') ? 'SEARCH_READY' :
          url.includes('/web-app') ? 'APP_HOME' :
          'UNKNOWN';
        return {
          url,
          title,
          pageKind,
          visibleMoreOptions,
          bodyPreview: bodyText.slice(0, 800),
        };
      }`
    );
    return result?.result || result;
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
        const controls = [...document.querySelectorAll('button,[role="button"],a,[role="link"],li,article,section,div,span')]
          .filter(visible);
        const activateButton = controls.find((el) => textOf(el) === exactActivateLabel) || null;
        const roomMentions = controls.filter((el) => textOf(el).includes(targetRoom));
        const roomCards = [...new Set(roomMentions
          .map((el) => el.closest('li,article,section,[role="group"],[role="listitem"],div'))
          .filter(Boolean))]
          .map((el) => textOf(el))
          .filter(Boolean);
        const bodyText = normalize(document.body?.innerText || '');
        const confirmSignals = [];
        if (!activateButton) confirmSignals.push('activate-button-hidden');
        if (roomCards.some((text) => text.includes(targetRoom))) confirmSignals.push('room-card-visible');
        if (roomCards.some((text) => /(当前|有效|输出|播放群组|暂停群组|群组|音量)/.test(text))) {
          confirmSignals.push('room-card-has-output-controls');
        }
        if (bodyText.includes(targetRoom)) confirmSignals.push('room-mentioned-on-page');
        const roomCardHasOutputControls = roomCards.some((text) => /(当前|有效|输出|播放群组|暂停群组|群组|音量)/.test(text));
        const roomCardVisible = roomCards.some((text) => text.includes(targetRoom));
        return {
          targetRoom,
          exactActivateLabel,
          activateButtonVisible: !!activateButton,
          activateButtonText: activateButton ? textOf(activateButton) : null,
          roomVisible: bodyText.includes(targetRoom),
          roomCardSamples: roomCards.slice(0, 5),
          confirmSignals,
          roomCardHasOutputControls,
          activeRoomConfirmed: (!activateButton && roomCardVisible) || roomCardHasOutputControls,
          url: location.href,
          title: document.title || '',
          bodyPreview: bodyText.slice(0, 800),
        };
      }`
    );
    return result?.result || result || {
      targetRoom: room,
      activeRoomConfirmed: false,
      activateButtonVisible: false,
      roomVisible: false,
      roomCardSamples: [],
      confirmSignals: [],
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
        const button = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')]
          .filter(visible)
          .find((el) => textOf(el) === exactActivateLabel);
        if (!button) {
          return { ok: false, reason: 'room-activate-button-not-found', exactActivateLabel };
        }
        button.click();
        return { ok: true, clicked: textOf(button), exactActivateLabel };
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
}
