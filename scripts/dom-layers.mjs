import { normalizeWhitespace } from './normalize.mjs';

export function buildReadLayeredPageStateFn() {
  return `() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const main = document.querySelector('main') || document.body;
    const allVisible = [...document.querySelectorAll('button,[role="button"],a,[role="link"],li,article,section,div,span,[role="row"],tr')].filter(visible);

    const zoneOf = (el) => {
      if (!el) return 'unknown';
      if (el.closest('footer,[data-testid*="now-playing"],[data-qa*="now-playing"],[class*="now-playing"],[class*="NowPlaying"]')) return 'now-playing';
      if (el.closest('header,nav,[role="navigation"],[role="banner"],[role="toolbar"],[data-testid*="header"],[data-testid*="system"]')) return 'system';
      const roomCard = el.closest('li,article,section,[role="group"],[role="listitem"]');
      if (roomCard && /设置为有效|播放群组|暂停群组|输出选择器|客厅|工作室|卧室|主卧|小房间|厨房|书房/.test(textOf(roomCard))) return 'room-card';
      const detailRoot = el.closest('[role="region"],section,article,div');
      if (detailRoot && /更多选项|随机播放|立即播放|替换队列|替换当前歌单|替换播放列表/.test(textOf(detailRoot)) && detailRoot.querySelector('[role="table"],[role="grid"],table')) return 'detail';
      if (detailRoot && /关闭/.test(textOf(detailRoot)) && /^https:\\/\\/play\\.sonos\\.com\\/zh-cn\\/browse\\/services\\//.test(location.href)) {
        const detailText = textOf(detailRoot);
        if (/QQ音乐|网易云音乐/.test(detailText) && /\\d{2}\\s+.+\\d{1,2}:\\d{2}/.test(detailText)) return 'detail';
      }
      if (el.closest('main')) return 'main';
      return 'unknown';
    };

    const byZone = (zone) => allVisible
      .filter((el) => zoneOf(el) === zone)
      .map((el) => textOf(el))
      .filter(Boolean);

    const roomCards = [...new Set(allVisible
      .filter((el) => zoneOf(el) === 'room-card')
      .map((el) => el.closest('li,article,section,[role="group"],[role="listitem"]'))
      .filter(Boolean))].map((card) => {
        const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible).map((el) => textOf(el)).filter(Boolean);
        return {
          text: textOf(card),
          buttons,
        };
      });

    const detailRoots = [...new Set(allVisible
      .filter((el) => zoneOf(el) === 'detail')
      .map((el) => el.closest('[role="region"],section,article,div'))
      .filter(Boolean))];
    const detail = detailRoots.map((root) => {
      const heading = textOf(root.querySelector('h1,h2,h3,h4,[role="heading"]'));
      const table = root.querySelector('[role="table"],[role="grid"],table');
      const rows = table ? [...table.querySelectorAll('[role="row"],tr')].filter(visible).map((row) => textOf(row)).filter(Boolean) : [];
      const buttons = [...root.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible).map((el) => textOf(el)).filter(Boolean);
      return { heading, rows: rows.slice(0, 20), buttons: buttons.slice(0, 20), text: textOf(root).slice(0, 500) };
    });

    const searchNodes = allVisible
      .filter((el) => zoneOf(el) === 'main')
      .map((el) => textOf(el))
      .filter(Boolean)
      .filter((text) => !/设置为有效|播放群组|暂停群组|输出选择器|正在播放|打开“正在播放”|音量/.test(text));

    const appError = /出错了|稍后重试|Something went wrong/i.test(textOf(main));
    const bootstrapBlank = !textOf(main) && roomCards.length === 0 && detail.length === 0;

    return {
      url: location.href,
      title: document.title || '',
      appError,
      bootstrapBlank,
      layers: {
        search: searchNodes.slice(0, 120),
        roomCards: roomCards.slice(0, 8),
        detail: detail.slice(0, 4),
        nowPlaying: byZone('now-playing').slice(0, 40),
        system: byZone('system').slice(0, 40),
      },
    };
  }`;
}
