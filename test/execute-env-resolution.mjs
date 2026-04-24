import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execute } from '../dist/server/execute.js';

const dir = await mkdtemp(join(tmpdir(), 'hermes-adapter-env-test-'));
const hermesShim = join(dir, 'hermes-shim.mjs');

await writeFile(
  hermesShim,
  `#!/usr/bin/env node\nconst payload = {\n  FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,\n  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,\n  FACEBOOK_PAGE_ACCESS_TOKEN_RESOLVED: process.env.FACEBOOK_PAGE_ACCESS_TOKEN === 'resolved-token-value',\n  FACEBOOK_PAGE_ACCESS_TOKEN_LENGTH: process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.length ?? 0,\n};\nconsole.log(JSON.stringify(payload));\nconsole.log('session_id: env-resolution-test-session');\n`,
  'utf8',
);
await chmod(hermesShim, 0o755);

const resolvedRuntimeConfig = {
  hermesCommand: hermesShim,
  model: 'test-model',
  provider: 'auto',
  persistSession: false,
  quiet: true,
  env: {
    FACEBOOK_PAGE_ID: '1059289847273344',
    FACEBOOK_APP_ID: '1718533292843876',
    FACEBOOK_PAGE_ACCESS_TOKEN: 'resolved-token-value',
  },
};

const unresolvedAdapterConfig = {
  hermesCommand: hermesShim,
  model: 'wrong-model-from-agent-config',
  provider: 'auto',
  persistSession: false,
  quiet: true,
  env: {
    FACEBOOK_PAGE_ID: { value: '1059289847273344' },
    FACEBOOK_APP_ID: { value: '1718533292843876' },
    FACEBOOK_PAGE_ACCESS_TOKEN: { secret_ref: 'facebook-page-token' },
  },
};

const logs = [];
try {
  const result = await execute({
    runId: 'test-run-id',
    agent: {
      id: 'agent-id',
      name: 'Env Test Agent',
      companyId: 'company-id',
      adapterConfig: unresolvedAdapterConfig,
    },
    config: resolvedRuntimeConfig,
    runtime: {},
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.session_id, 'env-resolution-test-session');

  const payload = JSON.parse(result.resultJson.result);
  assert.deepEqual(payload, {
    FACEBOOK_PAGE_ID: '1059289847273344',
    FACEBOOK_APP_ID: '1718533292843876',
    FACEBOOK_PAGE_ACCESS_TOKEN_RESOLVED: true,
    FACEBOOK_PAGE_ACCESS_TOKEN_LENGTH: 'resolved-token-value'.length,
  });

  const combinedLogs = logs.map((entry) => entry.chunk).join('\n');
  assert.ok(!combinedLogs.includes('resolved-token-value'), 'resolved secret must not be logged by adapter start/log metadata');
  assert.ok(!combinedLogs.includes('[object Object]'), 'unresolved env binding objects must not reach child process logs');
} finally {
  await rm(dir, { recursive: true, force: true });
}
