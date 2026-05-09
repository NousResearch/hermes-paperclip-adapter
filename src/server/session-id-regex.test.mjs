/**
 * Regression test for the legacy session-ID regex.
 *
 * The unanchored pattern false-matched the literal word "from" inside the
 * error message "Use a session ID from a previous CLI run", corrupting
 * downstream session state. Anchoring to start-of-line + multiline mode
 * fixes it.
 *
 * Plain ESM + node:test so this file runs without TS tooling:
 *   node --test src/server/session-id-regex.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const SESSION_ID_REGEX_LEGACY =
  /^\s*session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/im;

test("does not capture 'from' inside the helper error message", () => {
  const stderr =
    "Session not found: from\nUse a session ID from a previous CLI run";
  const match = stderr.match(SESSION_ID_REGEX_LEGACY);
  assert.equal(match, null);
});

test("captures a real legacy 'session_id: <id>' line", () => {
  const stdout = "session_id: 01J9X2PQRSTUVWXYZ_abc";
  const match = stdout.match(SESSION_ID_REGEX_LEGACY);
  assert.equal(match?.[1], "01J9X2PQRSTUVWXYZ_abc");
});

test("captures 'session saved: <id>' on its own line", () => {
  const stdout = "noise\nsession saved: 01J9X2PQRSTUVWXYZ_abc\nmore";
  const match = stdout.match(SESSION_ID_REGEX_LEGACY);
  assert.equal(match?.[1], "01J9X2PQRSTUVWXYZ_abc");
});

test("ignores 'session id' that appears mid-sentence", () => {
  const stdout = "Use a session id from a previous CLI run";
  const match = stdout.match(SESSION_ID_REGEX_LEGACY);
  assert.equal(match, null);
});
