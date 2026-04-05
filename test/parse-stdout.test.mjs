import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHermesStdoutLine } from '../dist/ui/parse-stdout.js';

const ts = '2026-04-04T18:00:00.000Z';

test('parseHermesStdoutLine emits thinking, tool_start, and matching tool_result entries', () => {
  assert.deepEqual(
    parseHermesStdoutLine('[hermes] Starting Hermes Agent (model=alpine-alpha)', ts),
    [{ kind: 'system', ts, text: '[hermes] Starting Hermes Agent (model=alpine-alpha)' }],
  );

  assert.deepEqual(
    parseHermesStdoutLine('  ┊ 💭 Checking issue context', ts),
    [{ kind: 'thinking', ts, text: 'Checking issue context' }],
  );

  const toolStart = parseHermesStdoutLine(
    '[tool] (｡◕‿◕｡) 💻 $         curl -s "http://127.0.0.1:3100/api/issues/LUK-231"',
    ts,
  );

  assert.equal(toolStart.length, 1);
  assert.equal(toolStart[0].kind, 'tool_call');
  assert.equal(toolStart[0].name, 'shell');
  assert.equal(toolStart[0].input.detail, 'curl -s "http://127.0.0.1:3100/api/issues/LUK-231"');
  assert.match(toolStart[0].toolUseId, /^hermes-tool-\d+$/);

  assert.deepEqual(
    parseHermesStdoutLine(
      '  [done] ┊ 💻 $         curl -s "http://127.0.0.1:3100/api/issues/LUK-231"  0.1s (0.1s)',
      ts,
    ),
    [
      {
        kind: 'tool_result',
        ts,
        toolUseId: toolStart[0].toolUseId,
        content: 'curl -s "http://127.0.0.1:3100/api/issues/LUK-231"  0.1s',
        isError: false,
      },
    ],
  );
});

test('parseHermesStdoutLine preserves duration-like command args on [tool] start lines', () => {
  parseHermesStdoutLine('[hermes] Starting Hermes Agent (model=alpine-alpha)', ts);

  const entries = parseHermesStdoutLine('[tool] (｡◕‿◕｡) 💻 $         sleep 5s', ts);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'tool_call');
  assert.equal(entries[0].input.detail, 'sleep 5s');
});

test('parseHermesStdoutLine compacts python-heavy tool details', () => {
  parseHermesStdoutLine('[hermes] Starting Hermes Agent (model=alpine-alpha)', ts);

  const entries = parseHermesStdoutLine(
    '[tool] (｡◕‿◕｡) 💻 $         curl -s "http://127.0.0.1:3100/api/issues/LUK-231/comments" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()))"',
    ts,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'tool_call');
  assert.equal(
    entries[0].input.detail,
    'curl -s "http://127.0.0.1:3100/api/issues/LUK-231/comments" | python3 -c <inline script>',
  );
});

test('parseHermesStdoutLine falls back to synthetic tool_call+tool_result when only a done line exists', () => {
  parseHermesStdoutLine('[hermes] Starting Hermes Agent (model=alpine-alpha)', ts);

  const entries = parseHermesStdoutLine(
    '  [done] ┊ 💻 $         echo done  0.1s (0.1s)',
    ts,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'tool_call');
  assert.equal(entries[0].name, 'shell');
  assert.equal(entries[0].input.detail, 'echo done');
  assert.equal(entries[1].kind, 'tool_result');
  assert.equal(entries[1].toolUseId, entries[0].toolUseId);
  assert.equal(entries[1].content, 'echo done  0.1s');
});
