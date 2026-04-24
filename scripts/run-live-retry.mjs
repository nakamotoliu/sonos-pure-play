import { normalizeText } from './normalize.mjs';
import { isRetryablePlaybackVerificationFailure } from './verify.mjs';

export const DEFAULT_MAX_CANDIDATES_PER_QUERY = Number(process.env.SONOS_MAX_CANDIDATES_PER_QUERY || 2);

function candidateKey(candidate = {}) {
  return [candidate.title, candidate.type, candidate.playLabel]
    .map((value) => normalizeText(value || ''))
    .join('::');
}

export function buildCandidateAttemptPool(surface, { maxCandidates = DEFAULT_MAX_CANDIDATES_PER_QUERY } = {}) {
  const usableBlocks = surface?.usableBlocks || {};
  const candidates = Array.isArray(usableBlocks?.candidates) ? usableBlocks.candidates : [];
  const selectedByRanker = usableBlocks?.selectionSummary?.selectedByRanker || null;
  const semanticCandidates = candidates.filter((candidate) => Number(candidate?.semanticMatchCount || 0) > 0);
  const recommendedCandidates = candidates.filter((candidate) => candidate?.recommended);

  if (!recommendedCandidates.length && !selectedByRanker && !semanticCandidates.length && !candidates.length) {
    return [];
  }

  const basePool = recommendedCandidates.length
    ? recommendedCandidates
    : semanticCandidates.length
      ? semanticCandidates
      : candidates;

  const ordered = [
    ...basePool.filter((candidate) => candidate?.recommended),
    ...basePool,
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
  const message = String(error?.message || error || '');

  if (['QUERY_NOT_CONFIRMED', 'SEARCH_INPUT_WRITE_FAILED', 'SEARCH_INPUT_NOT_FOUND'].includes(code)) {
    return true;
  }

  if (message.includes('Search results not fresh for query')) {
    return true;
  }

  return ['navigate', 'recover-search-page', 'query-gate', 'surface-read'].includes(step)
    && ['STEP_VERIFICATION_FAILED', 'STEP_EXECUTION_FAILED', 'BROWSER_ATTACH_FAILED'].includes(code);
}
