import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillError } from './normalize.mjs';
import { SEARCH_URL, SONOS_HOST } from './selectors.mjs';

function readGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;

  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

export class ChromeMcpRunner {
  constructor({ profile = 'user', logger = () => {}, baseUrl = SEARCH_URL } = {}) {
    this.profile = profile;
    this.logger = logger;
    this.baseUrl = baseUrl;
    this.gatewayToken = readGatewayToken();
  }

  log(event) {
    this.logger({ ok: true, phase: 'mcp-runner', ...event });
  }

  oc(args, { parseJson = true } = {}) {
    const base = ['browser', '--json'];
    if (this.gatewayToken) base.push('--token', this.gatewayToken);
    base.push(...args);

    try {
      const raw = execFileSync('openclaw', base, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseJson ? JSON.parse(raw) : raw;
    } catch (error) {
      const stderr = String(error?.stderr || error?.message || error);
      const profileHint = /Could not connect to Chrome/i.test(stderr)
        ? ` OpenClaw browser profile '${this.profile}' is not attached to a live Chrome runtime.`
        : '';
      throw new SkillError(
        'mcp-runner',
        'MCP_ATTACH_FAILED',
        `${stderr}${profileHint}`.trim(),
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
    this.waitForLoad(targetId);
  }

  press(targetId, key) {
    this.oc(['press', key, '--target-id', targetId], { parseJson: false });
  }

  click(targetId, ref) {
    this.oc(['click', ref, '--target-id', targetId], { parseJson: false });
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
    let tab = this.tabs().find((entry) => String(entry.url || '').includes(SONOS_HOST));

    if (!tab) {
      this.oc(['open', SEARCH_URL]);
      this.oc(['wait', '--url', '**play.sonos.com/**', '--timeout-ms', '30000'], { parseJson: false });
      tab = this.tabs().find((entry) => String(entry.url || '').includes(SONOS_HOST));
    }

    if (!tab?.targetId) {
      throw new SkillError(
        'mcp-runner',
        'SONOS_WEB_NOT_READY',
        'Unable to find or open the Sonos Web App in the existing Chrome MCP session.'
      );
    }

    this.focus(tab.targetId);
    this.waitForLoad(tab.targetId);
    this.log({ event: 'tab-ready', targetId: tab.targetId, url: tab.url || null });
    return tab.targetId;
  }

  readPageState(targetId) {
    const result = this.evaluate(
      targetId,
      `() => {
        const bodyText = (document.body?.innerText || '').trim();
        const url = location.href;
        const title = document.title || '';
        const menuItems = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],li')]
          .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
          .filter(Boolean);
        const pageKind =
          menuItems.includes('更多选项') ? 'DETAIL_PAGE' :
          url.includes('/search') && /搜索记录|查看全部|网易云音乐|QQ音乐|播放/.test(bodyText) ? 'SEARCH_LIVE' :
          url.includes('/search') ? 'SEARCH_READY' :
          url.includes('/web-app') ? 'APP_HOME' :
          'UNKNOWN';
        return {
          url,
          title,
          pageKind,
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
