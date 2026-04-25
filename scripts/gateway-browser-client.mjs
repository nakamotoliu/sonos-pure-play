import { randomUUID } from 'node:crypto';

const OPENCLAW_CALL_MODULE = '/opt/homebrew/lib/node_modules/openclaw/dist/call-DQa6BWy2.js';
const OPENCLAW_CHANNEL_MODULE = '/opt/homebrew/lib/node_modules/openclaw/dist/message-channel-CMzhST9r.js';

let runtimePromise = null;

async function loadRuntime() {
  runtimePromise ??= Promise.all([
    import(OPENCLAW_CALL_MODULE),
    import(OPENCLAW_CHANNEL_MODULE),
  ]).then(([callModule, channelModule]) => ({
    callGateway: callModule.r,
    clientNames: channelModule.g,
    clientModes: channelModule.h,
  }));
  return runtimePromise;
}

export class GatewayBrowserClient {
  constructor({ profile = 'openclaw', timeoutMs = 90000, logger = () => {} } = {}) {
    this.profile = profile;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.instanceId = `sonos-browser-${randomUUID()}`;
    this.closed = false;
    this.requestCount = 0;
  }

  async request({ method = 'POST', path, query = {}, body = undefined, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) throw new Error('GatewayBrowserClient is closed');
    if (!path) throw new Error('GatewayBrowserClient request path is required');

    const { callGateway, clientNames, clientModes } = await loadRuntime();
    const startedAt = Date.now();
    const requestId = ++this.requestCount;
    const params = {
      method,
      path,
      query: { ...query, profile: this.profile },
      body,
      timeoutMs,
    };

    try {
      const result = await callGateway({
        method: 'browser.request',
        params,
        timeoutMs,
        instanceId: this.instanceId,
        clientName: clientNames.CLI,
        mode: clientModes.CLI,
        clientDisplayName: 'sonos-browser-runner',
      });
      this.logger({
        event: 'gateway-browser-request-ok',
        requestId,
        method,
        path,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.logger({
        event: 'gateway-browser-request-failed',
        requestId,
        method,
        path,
        elapsedMs: Date.now() - startedAt,
        message: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }
  }

  async act(body, options = {}) {
    return this.request({ method: 'POST', path: '/act', body, ...options });
  }

  async tabs(options = {}) {
    return this.request({ method: 'GET', path: '/tabs', ...options });
  }

  async open(url, options = {}) {
    return this.request({ method: 'POST', path: '/tabs/open', body: { url }, ...options });
  }

  async focus(targetId, options = {}) {
    return this.request({ method: 'POST', path: '/tabs/focus', body: { targetId }, ...options });
  }

  async close(targetId, options = {}) {
    return this.request({ method: 'DELETE', path: `/tabs/${encodeURIComponent(targetId)}`, ...options });
  }

  closeClient() {
    this.closed = true;
    return { ok: true, requestCount: this.requestCount };
  }
}
