import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableBrowserAttachError,
  summarizeBrowserAttachError,
} from './browser-runner.mjs';

test('marks gateway timeout as retryable', () => {
  assert.equal(
    isRetryableBrowserAttachError(
      'Error: gateway timeout after 20000ms\nGateway target: ws://127.0.0.1:18789\nSource: local loopback'
    ),
    true
  );
});

test('marks socket reset as retryable', () => {
  assert.equal(isRetryableBrowserAttachError('connect ECONNRESET 127.0.0.1:18789'), true);
});

test('does not mark auth/config failures as retryable', () => {
  assert.equal(isRetryableBrowserAttachError('gateway token missing'), false);
  assert.equal(isRetryableBrowserAttachError('unknown browser profile openclaw'), false);
});

test('adds a short attach summary for transient gateway failures', () => {
  assert.match(
    summarizeBrowserAttachError('gateway timeout after 20000ms'),
    /attach timed out|socket dropped/i
  );
});
