import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProvider,
} from '../dist/server/detect-model.js';
import {
  CLI_FLAG_PROVIDERS,
  ENV_ONLY_PROVIDERS,
  VALID_PROVIDERS,
} from '../dist/shared/constants.js';

test('explicit opencode-go provider wins over model-name inference', () => {
  const resolved = resolveProvider({
    explicitProvider: 'opencode-go',
    model: 'kimi-k2.6',
  });

  assert.deepEqual(resolved, {
    provider: 'opencode-go',
    resolvedFrom: 'adapterConfig',
  });
});

test('opencode-go is accepted as config provider but not passed as a Hermes CLI --provider flag', () => {
  assert.equal(VALID_PROVIDERS.includes('opencode-go'), true);
  assert.equal(ENV_ONLY_PROVIDERS.includes('opencode-go'), true);
  assert.equal(CLI_FLAG_PROVIDERS.includes('opencode-go'), false);
});
