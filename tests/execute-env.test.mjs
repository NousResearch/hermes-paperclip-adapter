import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConfiguredEnv, resolveEnvValue } from '../dist/server/execute.js';

test('resolveEnvValue passes through plain strings', () => {
  assert.equal(resolveEnvValue('/tmp/hermes'), '/tmp/hermes');
});

test('resolveEnvValue unwraps Paperclip plain env objects', () => {
  assert.equal(
    resolveEnvValue({ type: 'plain', value: '/home/doug/.hermes/profiles/researcher' }),
    '/home/doug/.hermes/profiles/researcher',
  );
});

test('resolveEnvValue unwraps legacy plain-shaped objects', () => {
  assert.equal(resolveEnvValue({ plain: '/tmp/legacy-home' }), '/tmp/legacy-home');
});

test('applyConfiguredEnv overlays only resolved string values', () => {
  const env = { EXISTING: '1' };
  applyConfiguredEnv(env, {
    HERMES_HOME: { type: 'plain', value: '/home/doug/.hermes/profiles/researcher' },
    PAPERCLIP_RUN_ID: 'abc123',
    DROP_ME: { type: 'secret' },
  });
  assert.deepEqual(env, {
    EXISTING: '1',
    HERMES_HOME: '/home/doug/.hermes/profiles/researcher',
    PAPERCLIP_RUN_ID: 'abc123',
  });
});
