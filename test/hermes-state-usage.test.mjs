import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { readHermesSessionUsage } from '../dist/server/execute.js';

function createHermesHome(row) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-state-'));
  const dbPath = join(dir, 'state.db');
  const sql = `
create table sessions (
  id text primary key,
  source text not null,
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read_tokens integer default 0,
  cache_write_tokens integer default 0,
  reasoning_tokens integer default 0,
  billing_provider text,
  billing_mode text,
  estimated_cost_usd real,
  actual_cost_usd real,
  cost_status text,
  cost_source text,
  pricing_version text,
  api_call_count integer default 0
);
insert into sessions (
  id, source, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, billing_provider, billing_mode,
  estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
  pricing_version, api_call_count
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
`;
  execFileSync('python3', ['-c', `
import json, sqlite3, sys
sql = sys.stdin.read()
create_sql, insert_sql = sql.split(';', 1)
con=sqlite3.connect(sys.argv[1])
values=json.loads(sys.argv[2])
con.execute(create_sql + ';')
con.execute(insert_sql, values)
con.commit()
con.close()
`, dbPath, JSON.stringify([
    row.id,
    'tool',
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.reasoning_tokens,
    row.billing_provider,
    row.billing_mode,
    row.estimated_cost_usd,
    row.actual_cost_usd,
    row.cost_status,
    row.cost_source,
    row.pricing_version,
    row.api_call_count,
  ])], { input: sql });
  return dir;
}

test('reads Hermes session usage from HERMES_HOME/state.db', async () => {
  const hermesHome = createHermesHome({
    id: 'sess_123',
    model: 'openai/gpt-5.4-mini',
    input_tokens: 1234,
    output_tokens: 56,
    cache_read_tokens: 789,
    cache_write_tokens: 12,
    reasoning_tokens: 34,
    billing_provider: 'openrouter',
    billing_mode: 'api_key',
    estimated_cost_usd: 0.0123,
    actual_cost_usd: 0.0456,
    cost_status: 'actual',
    cost_source: 'provider',
    pricing_version: 'test-pricing',
    api_call_count: 2,
  });
  try {
    const usage = await readHermesSessionUsage('sess_123', { HERMES_HOME: hermesHome }, {});
    assert.deepEqual(usage?.usage, {
      inputTokens: 1234,
      cachedInputTokens: 789,
      outputTokens: 56,
    });
    assert.equal(usage?.costUsd, 0.0456);
    assert.equal(usage?.provider, 'openrouter');
    assert.equal(usage?.model, 'openai/gpt-5.4-mini');
    assert.equal(usage?.details.usage_source, 'hermes_state_db');
    assert.equal(usage?.details.cache_write_tokens, 12);
    assert.equal(usage?.details.reasoning_tokens, 34);
    assert.equal(usage?.details.api_call_count, 2);
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('uses estimated cost and preserves null actual cost when provider actual is unavailable', async () => {
  const hermesHome = createHermesHome({
    id: 'sess_estimated',
    model: 'openai/gpt-5.4-mini',
    input_tokens: 438,
    output_tokens: 31,
    cache_read_tokens: 9216,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'openrouter',
    billing_mode: null,
    estimated_cost_usd: 0.0011592,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'provider_models_api',
    pricing_version: null,
    api_call_count: 1,
  });
  try {
    const usage = await readHermesSessionUsage('sess_estimated', { HERMES_HOME: hermesHome }, {});
    assert.equal(usage?.costUsd, 0.0011592);
    assert.equal(usage?.details.actual_cost_usd, null);
    assert.equal(usage?.details.estimated_cost_usd, 0.0011592);
    assert.equal(usage?.billingType, 'unknown');
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('returns null instead of throwing when state.db is missing', async () => {
  const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-state-missing-'));
  try {
    const usage = await readHermesSessionUsage('sess_missing', { HERMES_HOME: hermesHome }, {});
    assert.equal(usage, null);
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});
