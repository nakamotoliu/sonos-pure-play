import { normalizeText } from './normalize.mjs';
import { isRetryablePlaybackVerificationFailure } from './verify.mjs';

export const DEFAULT_MAX_CANDIDATES_PER_QUERY = Number(process.env.SONOS_MAX_CANDIDATES_PER_QUERY || 3);

function candidateKey(candidate = {}) {
  return [candidate.title, candidate.type, candidate.playLabel]
    .map((value) => normalizeText(value || ''))
    .join('::');
}

export function buildCandidateAttemptPool(surface, { maxCandidates = DEFAULT_MAX_CANDIDATES_PER_QUERY } = {}) {
  const candidates = Array.isArray(surface?.usableBlocks?.candidates) ? surface.usableBlocks.candidates : [];
  const ordered = [
    ...candidates.filter((candidate) => candidate?.recommended),
    ...candidates,
  ];

  const seen = new Set();
  const unique = [];
  for (const candidate of ordered) {
    const key = candidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= maxCandidates) break;
  }
  return unique;
}

export function shouldRetryWithNextCandidate(error) {
  if (!error) return false;
  if (isRetryablePlaybackVerificationFailure(error)) return true;

  const code = String(error?.code || '');
  const step = String(error?.data?.step || '');
  if (step === 'candidate-click' || step === 'playback-action') return true;

  return [
    'PLAYBACK_MENU_ENTRY_NOT_FOUND',
    'PLAYBACK_MENU_OPEN_FAILED',
    'PLAYBACK_MENU_ACTIONS_NOT_VISIBLE',
    'PLAYBACK_ACTION_NOT_FOUND',
    'PLAYBACK_ACTION_CLICK_FAILED',
    'PLAYBACK_ACTION_FAILED',
    'STEP_VERIFICATION_FAILED',
  ].includes(code);
}

export function shouldRetryWithNextQuery(error) {
  if (!error) return false;
  const code = String(error?.code || '');
  const step = String(error?.data?.step || '');

  if (['QUERY_NOT_CONFIRMED', 'SEARCH_INPUT_WRITE_FAILED', 'SEARCH_INPUT_NOT_FOUND'].includes(code)) {
    return true;
  }

  return ['navigate', 'query-gate', 'surface-read'].includes(step)
    && ['STEP_VERIFICATION_FAILED', 'STEP_EXECUTION_FAILED', 'BROWSER_ATTACH_FAILED'].includes(code);
}
