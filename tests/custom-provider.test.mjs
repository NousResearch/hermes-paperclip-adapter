import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelFromConfig, resolveProvider, testEnvironment } from '../dist/server/index.js';

test('parseModelFromConfig tracks api_key presence without exposing the raw secret', () => {
  const parsed = parseModelFromConfig([
    'model:',
    '  default: oca/gpt-5.4',
    '  provider: custom',
    '  base_url: https://example.invalid/litellm',
    '  api_key: super-secret-value',
    '',
  ].join('\n'));

  assert.ok(parsed);
  assert.equal(parsed.hasApiKey, true);
  assert.equal(Object.hasOwn(parsed, 'apiKey'), false);
});

test('resolveProvider does not fall through to model inference when Hermes config provider is unsupported but matches the requested model', () => {
  const result = resolveProvider({
    explicitProvider: undefined,
    detectedProvider: 'custom',
    detectedModel: 'oca/gpt-5.4',
    detectedBaseUrl: 'https://example.invalid/litellm',
    detectedHasApiKey: true,
    model: 'oca/gpt-5.4',
  });

  assert.deepEqual(result, {
    provider: 'auto',
    resolvedFrom: 'hermesConfigUnsupported:custom',
  });
});

test('resolveProvider also defers to Hermes runtime when the matching config omits provider but includes runtime signals', () => {
  const result = resolveProvider({
    explicitProvider: undefined,
    detectedProvider: '',
    detectedModel: 'oca/gpt-5.4',
    detectedBaseUrl: 'https://example.invalid/litellm',
    detectedHasApiKey: true,
    model: 'oca/gpt-5.4',
  });

  assert.deepEqual(result, {
    provider: 'auto',
    resolvedFrom: 'hermesConfigRuntime',
  });
});

test('resolveProvider still infers from the requested model when Hermes config is for a different model', () => {
  const result = resolveProvider({
    explicitProvider: undefined,
    detectedProvider: 'custom',
    detectedModel: 'oca/gpt-5.4',
    detectedBaseUrl: 'https://example.invalid/litellm',
    detectedHasApiKey: true,
    model: 'claude-sonnet-4',
  });

  assert.deepEqual(result, {
    provider: 'anthropic',
    resolvedFrom: 'modelInference',
  });
});

async function withHermesHomeConfig(configLines, fn) {
  const tempHome = await mkdtemp(join(tmpdir(), 'hermes-paperclip-adapter-'));
  const hermesDir = join(tempHome, '.hermes');
  const configPath = join(hermesDir, 'config.yaml');
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  await mkdir(hermesDir, { recursive: true });
  await writeFile(configPath, `${configLines.join('\n')}\n`, 'utf8');
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}

test('testEnvironment does not warn about missing API keys when Hermes config provides a supported provider api_key', async () => {
  await withHermesHomeConfig([
    'model:',
    '  default: openrouter/gpt-4.1-mini',
    '  provider: openrouter',
    '  api_key: test-secret',
  ], async () => {
    const result = await testEnvironment({
      config: {
        hermesCommand: 'python3',
        model: 'openrouter/gpt-4.1-mini',
      },
    });

    const codes = result.checks.map((check) => check.code);

    assert.equal(codes.includes('hermes_no_api_keys'), false, JSON.stringify(result.checks, null, 2));
    assert.equal(result.status, 'pass', JSON.stringify(result.checks, null, 2));
  });
});

test('testEnvironment describes provider-omitted runtime config without inventing provider "auto"', async () => {
  await withHermesHomeConfig([
    'model:',
    '  default: oca/gpt-5.4',
    '  base_url: https://example.invalid/litellm',
    '  api_key: test-secret',
  ], async () => {
    const result = await testEnvironment({
      config: {
        hermesCommand: 'python3',
        model: 'oca/gpt-5.4',
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === 'hermes_api_key_in_config');
    assert.ok(apiKeyCheck, JSON.stringify(result.checks, null, 2));
    assert.match(apiKeyCheck.message, /without an explicit provider/i);
    assert.doesNotMatch(apiKeyCheck.message, /provider "auto"/i);
  });
});

test('testEnvironment does not warn about missing API keys when Hermes config provides a custom provider base_url and api_key', async () => {
  await withHermesHomeConfig([
    'model:',
    '  default: oca/gpt-5.4',
    '  provider: custom',
    '  base_url: https://example.invalid/litellm',
    '  api_key: test-secret',
  ], async () => {
    const result = await testEnvironment({
      config: {
        hermesCommand: 'python3',
        model: 'oca/gpt-5.4',
      },
    });

    const codes = result.checks.map((check) => check.code);

    assert.equal(codes.includes('hermes_no_api_keys'), false, JSON.stringify(result.checks, null, 2));
    assert.equal(result.status, 'pass', JSON.stringify(result.checks, null, 2));
  });
});
