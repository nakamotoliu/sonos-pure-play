#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const query = process.argv[2];
const room = process.argv[3] || '客厅 play5';
const menuMode = process.argv[4] || 'replace-first'; // replace-first|append-first|immediate-only

if (!query) {
  console.error('Usage: page-agent-web-flow.mjs <query> [room] [menuMode]');
  process.exit(2);
}

function resolveGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const token = cfg?.gateway?.auth?.token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  } catch {}
  return '';
}

const apiKey = resolveGatewayToken();
if (!apiKey) {
  console.error('Missing gateway token (set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token in ~/.openclaw/openclaw.json)');
  process.exit(2);
}

const hasBrowserPageController =
  typeof globalThis.window !== 'undefined' &&
  typeof globalThis.document !== 'undefined';

if (!hasBrowserPageController) {
  console.error(JSON.stringify({
    ok: false,
    step: 'bootstrap',
    error: 'PageController requires a browser page context; plain Node runtime is unsupported.',
    hint: 'Run this flow from an OpenClaw/browser-hosted page runtime instead of direct node execution.'
  }, null, 2));
  process.exit(2);
}

let PageAgent;
try {
  const mod = await import('page-agent');
  PageAgent = mod?.PageAgent;
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    step: 'bootstrap',
    code: 'PAGE_AGENT_IMPORT_FAILED',
    error: String(err?.message || err),
    hint: 'Install/resolve page-agent in the execution runtime before MEDIA_FLOW.'
  }, null, 2));
  process.exit(2);
}

if (typeof PageAgent !== 'function') {
  console.error(JSON.stringify({
    ok: false,
    step: 'bootstrap',
    code: 'PAGE_AGENT_INVALID_EXPORT',
    error: 'page-agent loaded but PageAgent export is missing/invalid.'
  }, null, 2));
  process.exit(2);
}

const model = process.env.PAGE_AGENT_MODEL;
if (!model || !String(model).trim()) {
  console.error('Missing PAGE_AGENT_MODEL (required; no silent default).');
  process.exit(2);
}

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const baseURL = `${String(gatewayUrl).replace(/\/$/, '')}/v1`;

const agent = new PageAgent({ model, baseURL, apiKey, language: 'zh-CN' });

const menuInstruction = {
  'replace-first': '打开“更多选项”，优先点击“替换队列”；若没有则点击“添加到队列末尾”；若只有“立即播放”则点击“立即播放”。',
  'append-first': '打开“更多选项”，优先点击“添加到队列末尾”；若没有则点击“替换队列”；若只有“立即播放”则点击“立即播放”。',
  'immediate-only': '打开“更多选项”，若有“立即播放”则点击“立即播放”，否则停止并返回失败。',
}[menuMode] || '打开“更多选项”，点击“替换队列”。';

try {
  await agent.execute(`在 Sonos 页面将“${room}”设为有效输出。`);
  await agent.execute(`在搜索框搜索：${query}。`);
  await agent.execute('进入最匹配的网易云音乐或QQ音乐播放列表详情页。');
  await agent.execute(menuInstruction);
  console.log(JSON.stringify({ ok: true, query, room, menuMode }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, step: 'web-flow', error: String(err?.message || err) }, null, 2));
  process.exit(1);
}
