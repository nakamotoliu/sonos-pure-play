#!/usr/bin/env node
/**
 * browser-bridge.mjs — legacy local browser shim for Sonos experiments.
 *
 * Uses Playwright connectOverCDP to drive the user's Chrome.
 * Chrome must be running with:
 *   --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Usage:
 *   node browser-bridge.mjs tabs
 *   node browser-bridge.mjs navigate <url> --target-id <tid>
 *   node browser-bridge.mjs evaluate --target-id <tid> --fn '<js>'
 *   node browser-bridge.mjs snapshot --target-id <tid>
 *   node browser-bridge.mjs press <key> --target-id <tid>
 *   node browser-bridge.mjs click <ref> --target-id <tid>
 *   node browser-bridge.mjs focus <tid>
 *   node browser-bridge.mjs open <url>
 *   node browser-bridge.mjs wait --time <ms>
 *   node browser-bridge.mjs wait --target-id <tid> --load domcontentloaded
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Resolve playwright-core
// ---------------------------------------------------------------------------
const PW_PATHS = [
  '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs',
  '/opt/homebrew/lib/node_modules/playwright-cli/node_modules/playwright-core/index.mjs',
  '/opt/homebrew/lib/node_modules/agent-browser/node_modules/playwright-core/index.mjs',
];

let chromium;
for (const p of PW_PATHS) {
  try {
    if (fs.existsSync(p)) {
      const pw = await import(p);
      chromium = pw.chromium;
      break;
    }
  } catch { /* try next */ }
}
if (!chromium) {
  console.error(JSON.stringify({ ok: false, error: 'playwright-core not found' }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
// Strip legacy browser-subcommand flags like --json / --browser-profile / --token.
// Note: --browser-profile is a browser-runtime selector, not the OpenClaw CLI global --profile.
const cleanArgs = [];
let i = 0;
while (i < args.length) {
  if (args[i] === '--json' || args[i] === '--browser-profile' || args[i] === '--token') {
    if (args[i] !== '--json') i++; // skip value for flags with values
    i++;
    continue;
  }
  cleanArgs.push(args[i]);
  i++;
}

const command = cleanArgs[0] || '';
function getArg(name) {
  const idx = cleanArgs.indexOf(name);
  return idx >= 0 && idx + 1 < cleanArgs.length ? cleanArgs[idx + 1] : null;
}
function getPositional(n) {
  // Get the nth positional arg (after command, skipping --flags)
  let count = 0;
  for (let j = 1; j < cleanArgs.length; j++) {
    if (cleanArgs[j].startsWith('--')) { j++; continue; } // skip flag + value
    if (count === n) return cleanArgs[j];
    count++;
  }
  return null;
}

const targetId = getArg('--target-id');

// ---------------------------------------------------------------------------
// CDP Connection (reuse via temp file for performance)
// ---------------------------------------------------------------------------
const CDP_STATE_FILE = path.join(os.tmpdir(), 'sonos-pure-play-cdp-state.json');

function readCdpEndpoint() {
  if (process.env.CDP_ENDPOINT) return process.env.CDP_ENDPOINT;
  const port = process.env.CDP_PORT || '9222';
  return `http://127.0.0.1:${port}`;
}

async function connectBrowser() {
  const endpoint = readCdpEndpoint();
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  } catch (err) {
    throw new Error(
      `CDP connect failed at ${endpoint}. ` +
      'Ensure Chrome is running with --remote-debugging-port=9222 --remote-allow-origins=*. ' +
      `Error: ${err.message}`
    );
  }
}

function findPage(browser, tid) {
  const allPages = browser.contexts().flatMap(c => c.pages());
  if (!allPages.length) return null;
  if (!tid) return allPages[0];

  // Match by pw_N index format (our tab IDs)
  const match = tid.match(/^pw_(\d+)$/);
  if (match) {
    const idx = parseInt(match[1], 10) - 1;
    if (idx >= 0 && idx < allPages.length) return allPages[idx];
  }

  // Match by URL fragment
  const byUrl = allPages.find(p => p.url().includes(tid));
  if (byUrl) return byUrl;

  // Match by numeric index
  const numTid = parseInt(tid, 10);
  if (!isNaN(numTid) && numTid >= 0 && numTid < allPages.length) return allPages[numTid];

  return allPages[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const browser = await connectBrowser();

  try {
    switch (command) {
      case 'tabs': {
        const allPages = browser.contexts().flatMap(c => c.pages());
        const tabs = allPages.map((p, idx) => ({
          targetId: `pw_${idx + 1}`,
          url: p.url(),
          title: '', // title requires async, skip for speed
        }));
        console.log(JSON.stringify({ ok: true, tabs }));
        break;
      }

      case 'focus': {
        const tid = getPositional(0) || targetId;
        const page = findPage(browser, tid);
        if (page) {
          await page.bringToFront();
          console.log(JSON.stringify({ ok: true }));
        } else {
          console.log(JSON.stringify({ ok: false, error: 'page not found' }));
        }
        break;
      }

      case 'close': {
        const tid = getPositional(0) || targetId;
        const page = findPage(browser, tid);
        if (!page) {
          console.log(JSON.stringify({ ok: false, error: 'page not found' }));
          break;
        }
        await page.close({ runBeforeUnload: false }).catch(() => {});
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'wait': {
        const ms = parseInt(getArg('--time') || '0', 10);
        const loadEvent = getArg('--load');
        const timeoutMs = parseInt(getArg('--timeout-ms') || '30000', 10);
        if (loadEvent && targetId) {
          const page = findPage(browser, targetId);
          if (page) {
            await page.waitForLoadState(
              loadEvent === 'domcontentloaded' ? 'domcontentloaded' : 'load',
              { timeout: timeoutMs }
            ).catch(() => {});
          }
        } else if (ms > 0) {
          await new Promise(r => setTimeout(r, ms));
        }
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'navigate': {
        const url = getPositional(0);
        const page = findPage(browser, targetId);
        if (!page || !url) {
          console.log(JSON.stringify({ ok: false, error: 'page or url missing' }));
          break;
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'press': {
        const key = getPositional(0);
        const page = findPage(browser, targetId);
        if (!page || !key) {
          console.log(JSON.stringify({ ok: false, error: 'page or key missing' }));
          break;
        }
        // Convert 'Meta+V' format to Playwright format
        await page.keyboard.press(key);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'click': {
        const ref = getPositional(0);
        const page = findPage(browser, targetId);
        if (!page || !ref) {
          console.log(JSON.stringify({ ok: false, error: 'page or ref missing' }));
          break;
        }
        await page.click(ref, { timeout: 5000 }).catch(() => {});
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'open': {
        const url = getPositional(0);
        const ctx = browser.contexts()[0];
        if (!ctx || !url) {
          console.log(JSON.stringify({ ok: false, error: 'no context or url' }));
          break;
        }
        const newPage = await ctx.newPage();
        await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'evaluate': {
        const fnSource = getArg('--fn');
        const page = findPage(browser, targetId);
        if (!page || !fnSource) {
          console.log(JSON.stringify({ ok: false, error: 'page or fn missing' }));
          break;
        }
        try {
          // The old API passes arrow functions as strings: `() => { ... }`
          // Playwright needs us to wrap and invoke: `(fnSource)()`
          const expression = `(${fnSource})()`;
          const result = await page.evaluate(expression);
          console.log(JSON.stringify({ ok: true, result }));
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: err.message }));
        }
        break;
      }

      case 'snapshot': {
        const page = findPage(browser, targetId);
        const limit = parseInt(getArg('--limit') || '260', 10);
        if (!page) {
          console.log(JSON.stringify({ ok: false, error: 'page not found' }));
          break;
        }
        try {
          // Build accessibility snapshot via page.evaluate as fallback
          const nodes = await page.evaluate(`(() => {
            const limit = ${limit};
            const result = [];
            const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
            const walk = (el) => {
              if (result.length >= limit || !el) return;
              const role = el.getAttribute('role') || el.tagName?.toLowerCase() || '';
              const name = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 100);
              if (role || name) result.push({ role, name, value: '' });
              for (const child of el.children || []) {
                if (result.length >= limit) break;
                if (visible(child)) walk(child);
              }
            };
            walk(document.body);
            return result;
          })()`);
          console.log(JSON.stringify({ ok: true, nodes: nodes || [] }));
        } catch (err) {
          console.log(JSON.stringify({ ok: true, nodes: [] }));
        }
        break;
      }

      case 'screenshot': {
        const tid = getPositional(0) || targetId;
        const page = findPage(browser, tid);
        if (!page) {
          console.log(JSON.stringify({ ok: false, error: 'page not found' }));
          break;
        }
        const filePath = path.join(os.tmpdir(), `sonos-pure-play-${Date.now()}-${process.pid}.png`);
        await page.screenshot({ path: filePath, fullPage: false }).catch((err) => {
          throw new Error(`screenshot failed: ${err.message}`);
        });
        console.log(`MEDIA:${filePath}`);
        break;
      }

      default:
        console.log(JSON.stringify({ ok: false, error: `unknown command: ${command}` }));
    }
  } finally {
    // Disconnect without closing the browser
    browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// A11y tree flattener (for snapshot compatibility)
// ---------------------------------------------------------------------------
function flattenA11yTree(node, limit, result = []) {
  if (!node || result.length >= limit) return result;
  result.push({
    role: node.role || '',
    name: node.name || '',
    value: node.value || '',
  });
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (result.length >= limit) break;
      flattenA11yTree(child, limit, result);
    }
  }
  return result;
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
