import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../src/server/execute.ts', import.meta.url), 'utf8');

test('execute forwards ctx.onSpawn to runChildProcess', () => {
  assert.match(
    source,
    /runChildProcess\(ctx\.runId,\s*hermesCmd,\s*args,\s*\{[\s\S]*?onSpawn:\s*ctx\.onSpawn,[\s\S]*?\}\);/m,
  );
});
