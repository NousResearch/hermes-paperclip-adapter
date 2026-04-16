import test from 'node:test';
import assert from 'node:assert/strict';

import { executeWithDeps } from '../dist/server/execute.js';

function makeContext(prevSessionId = '20260416_222027_9665cb') {
  const logs = [];
  return {
    logs,
    ctx: {
      runId: 'run-1',
      agent: {
        id: 'agent-1',
        companyId: 'company-1',
        name: 'Hermes Worker',
        adapterType: 'hermes_local',
        adapterConfig: {},
      },
      runtime: {
        sessionId: prevSessionId,
        sessionParams: prevSessionId ? { sessionId: prevSessionId } : null,
        sessionDisplayId: prevSessionId,
        taskKey: null,
      },
      config: {
        cwd: '/tmp',
        provider: 'auto',
        persistSession: true,
      },
      context: {},
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    },
  };
}

test('retries once with a fresh session when a resumed Hermes session aborts', async () => {
  const { ctx, logs } = makeContext();
  const calls = [];

  const result = await executeWithDeps(ctx, {
    runChildProcessImpl: async (_runId, command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: '↻ Resumed session 20260416_222027_9665cb (4 user messages, 4 total messages)\n\nsession_id: 20260416_222027_9665cb\n',
          stderr: 'Aborted(). Build with -sASSERTIONS for more info.\n',
          pid: 100,
          startedAt: '2026-04-16T14:26:37.000Z',
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'Fresh session completed the task.\n\nsession_id: 20260416_230000_fresh123\n',
        stderr: '',
        pid: 101,
        startedAt: '2026-04-16T14:26:48.000Z',
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--resume'));
  assert.ok(calls[0].args.includes('20260416_222027_9665cb'));
  assert.ok(!calls[1].args.includes('--resume'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionParams?.sessionId, '20260416_230000_fresh123');
  assert.equal(result.resultJson?.session_id, '20260416_230000_fresh123');
  assert.match(result.summary ?? '', /Fresh session completed the task/);
  assert.ok(logs.some((entry) => entry.chunk.includes('retrying once with a fresh session')));
});
