import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRetryWithNextCandidate } from './run-live-retry.mjs';
import { SkillError } from './normalize.mjs';

test('retries next candidate when detail surface is copyright blocked before playback', () => {
  const error = new SkillError(
    'browser-action',
    'PLAYBACK_SURFACE_COPYRIGHT_BLOCKED',
    'The selected Sonos detail page contains copyright/unavailable markers before playback.',
    { retryable: true, retryReason: 'copyright-unavailable-surface' }
  );

  assert.equal(shouldRetryWithNextCandidate(error), true);
});
