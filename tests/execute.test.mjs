/**
 * Regression tests for session-id parsing and persistence.
 *
 * Run with: `npm test` (which builds first, then `node --test tests/`).
 *
 * These tests target the compiled `dist/` output rather than the `.ts`
 * sources so they can run with stock Node without a TS loader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseHermesOutput,
  buildPersistedSessionParams,
} from "../dist/server/execute.js";

// ---------------------------------------------------------------------------
// parseHermesOutput
// ---------------------------------------------------------------------------

test("parseHermesOutput extracts session id from strict quiet-mode line", () => {
  const stdout = [
    "Hello, world.",
    "",
    "session_id: 01HZK9X7YJN1ABCD2EFGH3IJKL",
  ].join("\n");
  const parsed = parseHermesOutput(stdout, "");
  assert.equal(parsed.sessionId, "01HZK9X7YJN1ABCD2EFGH3IJKL");
});

test("parseHermesOutput does NOT infer a session id from prose in stderr", () => {
  // This is the exact failure mode that produced `--resume from` and
  // looped the agent on broken sessions. The phrase appeared in stderr
  // and the old legacy regex captured "from" as the session id.
  const stderr = "Use a session ID from a previous CLI run.";
  const parsed = parseHermesOutput("", stderr);
  assert.equal(parsed.sessionId, undefined, "must not capture 'from'");
});

test("parseHermesOutput does NOT infer a session id from 'session expired' stderr", () => {
  const stderr = "Error: session expired. Please start a new session.";
  const parsed = parseHermesOutput("", stderr);
  assert.equal(parsed.sessionId, undefined);
});

test("parseHermesOutput does NOT capture from free-text 'session id: foo' lines", () => {
  // The legacy regex was case-insensitive and matched "session id:" anywhere
  // in the combined output. Strict mode requires the literal anchored line.
  const stderr = "hint: pass --session id: foo to resume";
  const parsed = parseHermesOutput("", stderr);
  assert.equal(parsed.sessionId, undefined);
});

// ---------------------------------------------------------------------------
// buildPersistedSessionParams
// ---------------------------------------------------------------------------

test("buildPersistedSessionParams persists on clean exit", () => {
  const out = buildPersistedSessionParams({
    persistSession: true,
    sessionId: "abc123",
    exitCode: 0,
    timedOut: false,
  });
  assert.deepEqual(out, { sessionId: "abc123" });
});

test("buildPersistedSessionParams refuses to persist when exit code is non-zero", () => {
  // This is the core regression: a Hermes run errors and still emits
  // something the parser thinks is a session id. Persisting it would
  // brick the next heartbeat with `--resume <bad-id>`.
  const out = buildPersistedSessionParams({
    persistSession: true,
    sessionId: "abc123",
    exitCode: 1,
    timedOut: false,
  });
  assert.equal(out, null);
});

test("buildPersistedSessionParams refuses to persist on timeout", () => {
  const out = buildPersistedSessionParams({
    persistSession: true,
    sessionId: "abc123",
    exitCode: null,
    timedOut: true,
  });
  assert.equal(out, null);
});

test("buildPersistedSessionParams returns null when persistSession is false", () => {
  const out = buildPersistedSessionParams({
    persistSession: false,
    sessionId: "abc123",
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(out, null);
});

test("buildPersistedSessionParams returns null when there is no session id", () => {
  const out = buildPersistedSessionParams({
    persistSession: true,
    sessionId: null,
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(out, null);
});
