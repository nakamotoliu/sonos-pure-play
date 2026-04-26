import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OPENCLAW_DIST_DIR = '/opt/homebrew/lib/node_modules/openclaw/dist';

let runtimePromise = null;


function newestDistFile(pattern) {
  const files = fs.readdirSync(OPENCLAW_DIST_DIR)
    .filter((file) => pattern.test(file))
    .map((file) => {
      const fullPath = path.join(OPENCLAW_DIST_DIR, file);
      return { file, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) throw new Error(`OpenClaw dist module not found: ${pattern}`);
  return files[0].fullPath;
}

async function importFirst(candidates) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await import(candidate.startsWith('file:') ? candidate : `file://${candidate}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function loadRuntime() {
  runtimePromise ??= Promise.all([
    importFirst([
      path.join(OPENCLAW_DIST_DIR, 'call-GfQsJ3MY.js'),
      newestDistFile(/^call-[A-Za-z0-9_-]+\.js$/),
    ]),
    importFirst([
      path.join(OPENCLAW_DIST_DIR, 'message-channel-C2Lnao8s.js'),
      ...fs.readdirSync(OPENCLAW_DIST_DIR)
        .filter((file) => /^message-channel-[A-Za-z0-9_-]+\.js$/.test(file) && !/^message-channel-core-/.test(file))
        .map((file) => path.join(OPENCLAW_DIST_DIR, file)),
    ]),
  ]).then(([callModule, channelModule]) => {
    const callGateway = callModule.callGateway || callModule.r;
    const clientNames = callModule.GATEWAY_CLIENT_NAMES || channelModule.GATEWAY_CLIENT_NAMES || channelModule.g;
    const clientModes = callModule.GATEWAY_CLIENT_MODES || channelModule.GATEWAY_CLIENT_MODES || channelModule.h;
    if (!callGateway || !clientNames?.CLI || !clientModes?.CLI) {
      throw new Error('OpenClaw gateway runtime exports not found');
    }
    return { callGateway, clientNames, clientModes };
  });
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
