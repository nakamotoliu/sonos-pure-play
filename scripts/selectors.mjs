export const SONOS_HOST = 'play.sonos.com';
export const SONOS_LOGIN_HOST = 'login.sonos.com';
export const SONOS_IDENTITY_HOST = 'idassets.sonos.com';
export const SONOS_URL = 'https://play.sonos.com/zh-cn/web-app';
export const SEARCH_URL = 'https://play.sonos.com/zh-cn/search';

export const VALID_ACTIONS = new Set(['replace-first', 'append-first', 'play-now']);
export const DEFAULT_ACTION = 'replace-first';

export const ACTION_PRIORITY = {
  'replace-first': ['替换队列', '立即播放'],
  'append-first': ['替换队列', '立即播放'],
  'play-now': ['立即播放'],
};
