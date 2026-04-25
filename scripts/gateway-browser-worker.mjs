#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { GatewayBrowserClient } from './gateway-browser-client.mjs';

const [ipcDir, profile = 'openclaw', timeoutRaw = '90000'] = process.argv.slice(2);
if (!ipcDir) {
  console.error('Usage: node gateway-browser-worker.mjs <ipcDir> [profile] [timeoutMs]');
  process.exit(2);
}

const timeoutMs = Number(timeoutRaw) || 90000;
fs.mkdirSync(ipcDir, { recursive: true });
const client = new GatewayBrowserClient({ profile, timeoutMs, logger: () => {} });
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRequest(filePath) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return;
  }
  const responsePath = path.join(ipcDir, `res-${request.id}.json`);
  try {
    if (request.kind === 'stop') {
      stopping = true;
      fs.writeFileSync(responsePath, JSON.stringify({ ok: true, result: client.closeClient() }));
      return;
    }
    const result = await client.request(request.params || {});
    fs.writeFileSync(responsePath, JSON.stringify({ ok: true, result }));
  } catch (error) {
    fs.writeFileSync(responsePath, JSON.stringify({
      ok: false,
      error: {
        message: String(error?.message || error),
        code: error?.code || null,
        stack: error?.stack || null,
      },
    }));
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

while (!stopping) {
  const files = fs.readdirSync(ipcDir)
    .filter((name) => /^req-.+\.json$/.test(name))
    .sort();
  for (const name of files) {
    await handleRequest(path.join(ipcDir, name));
    if (stopping) break;
  }
  if (!stopping) await sleep(15);
}
