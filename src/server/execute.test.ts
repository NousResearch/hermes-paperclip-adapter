import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidSessionId,
  parseHermesOutput,
  sanitizeUserEnv,
} from "./execute.js";

describe("isValidSessionId", () => {
  it("accepts real Hermes session IDs (YYYYMMDD_HHMMSS_<suffix>)", () => {
    assert.equal(isValidSessionId("20260609_153047_5568c8"), true);
    assert.equal(isValidSessionId("20260609_145320_815d6f"), true);
    assert.equal(isValidSessionId("20991231_000000_abc123def"), true);
  });

  it("rejects prose captured from error output", () => {
    // The exact word the loose legacy regex used to capture from
    // "Use a session ID from a previous CLI run".
    assert.equal(isValidSessionId("from"), false);
  });

  it("rejects empty / malformed / non-string values", () => {
    assert.equal(isValidSessionId(""), false);
    assert.equal(isValidSessionId("abc123"), false);
    assert.equal(isValidSessionId("20260609_153047_"), false); // missing suffix
    assert.equal(isValidSessionId("2026-06-09_15:30:47_x"), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(null), false);
    assert.equal(isValidSessionId(42), false);
  });
});

describe("parseHermesOutput — session id capture", () => {
  it("does NOT capture 'from' out of the 'Session not found' error prose (regression)", () => {
    // Reproduces the death-loop: a failed run whose stderr is hermes' own
    // error message, with no canonical `session_id:` line.
    const stderr =
      "Session not found: 20260609_153047_5568c8\n" +
      "Use a session ID from a previous CLI run (hermes sessions list).\n";
    const parsed = parseHermesOutput("", stderr);
    assert.notEqual(parsed.sessionId, "from");
    assert.equal(parsed.sessionId, undefined);
  });

  it("captures the canonical quiet-mode session_id line", () => {
    const stdout = "Here is the answer.\n\nsession_id: 20260609_153047_5568c8\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, "20260609_153047_5568c8");
  });

  it("accepts a well-formed legacy 'session saved' id", () => {
    const stdout = "work done\nsession saved: 20260101_010101_deadbe\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, "20260101_010101_deadbe");
  });
});

describe("sanitizeUserEnv", () => {
  it("passes string values through", () => {
    const { env, warnings } = sanitizeUserEnv({ FOO: "bar", BAZ: "qux" });
    assert.deepEqual(env, { FOO: "bar", BAZ: "qux" });
    assert.equal(warnings.length, 0);
  });

  it("skips an unresolved secret_ref and never injects '[object Object]'", () => {
    const { env, warnings } = sanitizeUserEnv({
      HUBSPOT_SERVICE_KEY: {
        type: "secret_ref",
        secretId: "077ebfd6-1def-4604-9d1f-309bee832a5d",
        version: "latest",
      },
      OPENAI_API_KEY: "sk-real-value",
    });
    assert.equal("HUBSPOT_SERVICE_KEY" in env, false);
    assert.notEqual(env.HUBSPOT_SERVICE_KEY, "[object Object]");
    assert.equal(env.OPENAI_API_KEY, "sk-real-value");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HUBSPOT_SERVICE_KEY/);
    assert.match(warnings[0], /secret_ref/);
  });

  it("skips other non-string values with a warning", () => {
    const { env, warnings } = sanitizeUserEnv({ N: 5, O: { a: 1 } });
    assert.deepEqual(env, {});
    assert.equal(warnings.length, 2);
  });

  it("ignores null/undefined silently and tolerates non-object input", () => {
    const { env, warnings } = sanitizeUserEnv({ A: null, B: undefined });
    assert.deepEqual(env, {});
    assert.equal(warnings.length, 0);
    assert.deepEqual(sanitizeUserEnv(undefined), { env: {}, warnings: [] });
    assert.deepEqual(sanitizeUserEnv("nope"), { env: {}, warnings: [] });
  });
});
