#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';

console.log('--- Sonos Skill Self-Check ---');

// 1. Check Node version
console.log(`[1] Node version: ${process.version}`);

// 2. Check dependencies
try {
  if (fs.existsSync('./node_modules')) {
    console.log('[2] node_modules found.');
  } else {
    console.warn('[2] WARNING: node_modules missing. Please run "npm install".');
  }
} catch (e) {}

// 3. Check Sonos CLI
try {
  const sonosVer = execSync('sonos --version').toString().trim();
  console.log(`[3] Sonos CLI: OK (${sonosVer})`);
} catch (e) {
  console.error('[3] ERROR: Sonos CLI (brew install sonos) not found.');
}

// 4. Check required token for gateway-auth mode
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
  console.log('[4] OPENCLAW_GATEWAY_TOKEN: present');
} else {
  try {
    const cfgRaw = fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, 'utf8');
    const cfg = JSON.parse(cfgRaw);
    if (cfg?.gateway?.auth?.token) {
      console.log('[4] gateway.auth.token in ~/.openclaw/openclaw.json: present (env fallback)');
    } else {
      console.warn('[4] WARNING: gateway token missing in env and config; MEDIA_FLOW web execution cannot start.');
    }
  } catch {
    console.warn('[4] WARNING: OPENCLAW_GATEWAY_TOKEN missing and cannot read ~/.openclaw/openclaw.json.');
  }
}

if (process.env.OPENCLAW_GATEWAY_URL) {
  console.log('[4b] OPENCLAW_GATEWAY_URL: present');
} else {
  console.log('[4b] OPENCLAW_GATEWAY_URL: not set (will default to http://127.0.0.1:18789)');
}

if (process.env.PAGE_AGENT_MODEL) {
  console.log('[4c] PAGE_AGENT_MODEL: present');
} else {
  console.warn('[4c] WARNING: PAGE_AGENT_MODEL missing; MEDIA_FLOW web execution should fail fast.');
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  console.log('[5] Browser page context: present');
} else {
  console.warn('[5] WARNING: Browser page context missing; page-agent web flow cannot run in plain Node.');
}

// 6. Check Git repo
try {
  const remote = execSync('git remote -v').toString();
  console.log(`[6] Git Remotes:\n${remote}`);
} catch (e) {}

console.log('--- Check Complete ---');
