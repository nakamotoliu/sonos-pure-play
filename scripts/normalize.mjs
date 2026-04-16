export class SkillError extends Error {
  constructor(phase, code, message, data = {}) {
    super(message);
    this.phase = phase;
    this.code = code;
    this.data = data;
  }
}

export function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function normalizeMenuLabel(label) {
  const value = normalizeWhitespace(label);
  if (['替换当前歌单', '替换播放列表', '替换队列'].includes(value)) return '替换队列';
  if (value === '立即播放') return value;
  if (value === '添加到队列末尾') return value;
  return value;
}

export function parseTimeToSeconds(value) {
  if (!value) return null;
  const parts = String(value).trim().split(':').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function getQueueCount(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line)).length;
}
