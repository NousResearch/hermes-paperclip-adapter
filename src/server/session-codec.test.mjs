/**
 * Regression tests for the session codec format validation.
 *
 * The codec must reject session IDs that do not match the Hermes format
 * (`YYYYMMDD_HHMMSS_<hex>`). Without validation, false-captured strings
 * like `"from"` (parsed from error output by the legacy regex) corrupt
 * stored session state and stall the agent loop.
 *
 * Plain ESM + node:test — runs without TS tooling:
 *   node --test src/server/session-codec.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

// Inline the validation regex (mirrors src/server/index.ts)
const HERMES_SESSION_ID_RE = /^\d{8}_\d{6}_[a-f0-9]+$/;

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readValidSessionId(value) {
  const s = readNonEmptyString(value);
  if (!s || !HERMES_SESSION_ID_RE.test(s)) return null;
  return s;
}

// Minimal codec replica for testing
const sessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const sessionId =
      readValidSessionId(raw.sessionId) ??
      readValidSessionId(raw.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      readValidSessionId(params.sessionId) ??
      readValidSessionId(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
};

// ── serialize ──────────────────────────────────────────────────────────

test("serialize: accepts a valid Hermes session ID", () => {
  const result = sessionCodec.serialize({
    sessionId: "20260513_091310_fb8871",
  });
  assert.deepStrictEqual(result, { sessionId: "20260513_091310_fb8871" });
});

test("serialize: rejects 'from' (false capture from error output)", () => {
  const result = sessionCodec.serialize({ sessionId: "from" });
  assert.equal(result, null);
});

test("serialize: rejects truncated session ID (missing hex hash)", () => {
  const result = sessionCodec.serialize({
    sessionId: "20260513_091310_",
  });
  assert.equal(result, null);
});

test("serialize: rejects empty string", () => {
  assert.equal(sessionCodec.serialize({ sessionId: "" }), null);
});

test("serialize: rejects null params", () => {
  assert.equal(sessionCodec.serialize(null), null);
});

// ── deserialize ────────────────────────────────────────────────────────

test("deserialize: accepts a valid session from JSONB object", () => {
  const result = sessionCodec.deserialize({
    sessionId: "20260512_125545_8aeee7",
  });
  assert.deepStrictEqual(result, { sessionId: "20260512_125545_8aeee7" });
});

test("deserialize: rejects 'from' in stored JSONB", () => {
  const result = sessionCodec.deserialize({ sessionId: "from" });
  assert.equal(result, null);
});

test("deserialize: rejects non-object input", () => {
  assert.equal(sessionCodec.deserialize("20260513_091310_fb8871"), null);
  assert.equal(sessionCodec.deserialize(null), null);
  assert.equal(sessionCodec.deserialize(42), null);
});

test("deserialize: reads session_id key (snake_case fallback)", () => {
  const result = sessionCodec.deserialize({
    session_id: "20260513_084138_197de3",
  });
  assert.deepStrictEqual(result, { sessionId: "20260513_084138_197de3" });
});

test("deserialize: rejects garbage in snake_case key too", () => {
  const result = sessionCodec.deserialize({ session_id: "from" });
  assert.equal(result, null);
});
