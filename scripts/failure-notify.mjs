import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FAILURE_NOTIFY_CONFIG_PATH = path.join(SCRIPT_DIR, '..', 'data', 'failure-notify.local.json');
export const DEFAULT_SUCCESS_ARTIFACT_ROOT = path.join(SCRIPT_DIR, '..', 'logs', 'success-artifacts.local');

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatLine(label, value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  return `${label}：${value}`;
}

export function loadFailureNotifyConfig({
  configPath = process.env.SONOS_FAILURE_NOTIFY_CONFIG || DEFAULT_FAILURE_NOTIFY_CONFIG_PATH,
  env = process.env,
} = {}) {
  const fileConfig = readJsonIfExists(configPath) || {};
  const enabled = typeof fileConfig.enabled === 'boolean'
    ? fileConfig.enabled
    : Boolean(env.SONOS_FAILURE_NOTIFY_TARGET || fileConfig.target);

  return {
    configPath,
    enabled,
    channel: env.SONOS_FAILURE_NOTIFY_CHANNEL || fileConfig.channel || 'telegram',
    target: env.SONOS_FAILURE_NOTIFY_TARGET || fileConfig.target || '',
    accountId: env.SONOS_FAILURE_NOTIFY_ACCOUNT || fileConfig.accountId || '',
    silent: typeof fileConfig.silent === 'boolean' ? fileConfig.silent : false,
    title: fileConfig.title || 'Sonos 技能失败现场',
  };
}

export function buildFailureNotifyCaption({
  title = 'Sonos 技能失败现场',
  capturedAt,
  step,
  room,
  request,
  query,
  targetId,
  artifactPath,
  screenshotPath,
  error,
  timeoutMs,
} = {}) {
  return [
    title,
    formatLine('时间', capturedAt),
    formatLine('步骤', step),
    formatLine('房间', room),
    formatLine('请求', request),
    formatLine('查询', query),
    formatLine('targetId', targetId),
    formatLine('超时(ms)', timeoutMs),
    formatLine('错误', error?.message || error),
    formatLine('JSON', artifactPath),
    formatLine('截图', screenshotPath),
  ].filter(Boolean).join('\n');
}

export function buildSuccessNotifyCaption({
  title = 'Sonos 技能执行成功',
  capturedAt,
  room,
  request,
  query,
  targetId,
  screenshotPath,
  chosenCandidate,
  playbackVerifyResult,
} = {}) {
  return [
    title,
    formatLine('时间', capturedAt),
    formatLine('房间', room),
    formatLine('请求', request),
    formatLine('查询', query),
    formatLine('targetId', targetId),
    formatLine('选择结果', chosenCandidate?.title || chosenCandidate?.name || null),
    formatLine('播放校验', playbackVerifyResult?.finalState || playbackVerifyResult?.matchedBy || null),
    formatLine('截图', screenshotPath),
  ].filter(Boolean).join('\n');
}

export function saveSuccessScreenshot({
  sourcePath,
  step = 'run-succeeded',
  capturedAt = new Date(),
  artifactRoot = DEFAULT_SUCCESS_ARTIFACT_ROOT,
} = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  fs.mkdirSync(artifactRoot, { recursive: true });
  const iso = new Date(capturedAt).toISOString().replace(/[:.]/g, '-');
  const safeStep = String(step || 'run-succeeded').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'run-succeeded';
  const ext = path.extname(sourcePath) || '.png';
  const outPath = path.join(artifactRoot, `${iso}-${safeStep}${ext}`);
  fs.copyFileSync(sourcePath, outPath);
  return outPath;
}

export function notifyFailureArtifact(payload = {}, options = {}) {
  const config = options.config || loadFailureNotifyConfig(options);
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: 'disabled', configPath: config.configPath };
  }
  if (!config.target) {
    return { ok: false, skipped: true, reason: 'missing-target', configPath: config.configPath };
  }

  const caption = buildFailureNotifyCaption({
    title: config.title,
    ...payload,
  });

  const args = ['message', 'send', '--channel', config.channel, '--target', config.target];
  if (config.accountId) args.push('--account', config.accountId);
  if (config.silent) args.push('--silent');

  const media = payload.screenshotPath;
  if (media && fs.existsSync(media)) {
    args.push('--media', media, '--caption', caption);
  } else {
    args.push('--message', caption);
  }

  const raw = execFileSync('openclaw', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }).trim();

  return {
    ok: true,
    skipped: false,
    configPath: config.configPath,
    usedMedia: Boolean(media && fs.existsSync(media)),
    raw,
  };
}

export function notifySuccessArtifact(payload = {}, options = {}) {
  const config = options.config || loadFailureNotifyConfig(options);
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: 'disabled', configPath: config.configPath };
  }
  if (!config.target) {
    return { ok: false, skipped: true, reason: 'missing-target', configPath: config.configPath };
  }

  const caption = buildSuccessNotifyCaption(payload);
  const args = ['message', 'send', '--channel', config.channel, '--target', config.target];
  if (config.accountId) args.push('--account', config.accountId);
  if (config.silent) args.push('--silent');

  const media = payload.screenshotPath;
  if (media && fs.existsSync(media)) {
    args.push('--media', media, '--caption', caption);
  } else {
    args.push('--message', caption);
  }

  const raw = execFileSync('openclaw', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }).trim();

  return {
    ok: true,
    skipped: false,
    configPath: config.configPath,
    usedMedia: Boolean(media && fs.existsSync(media)),
    raw,
  };
}
