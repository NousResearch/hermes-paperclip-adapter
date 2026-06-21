/**
 * Regression test for RUAAAAA-1977 / RUAAAAA-2033 / RUAAAAA-2035:
 *   The legacy SESSION_ID_REGEX in hermes-paperclip-adapter@0.2.0 used to
 *   match the Hermes CLI help text "Use a session ID from a previous CLI run"
 *   and capture the literal word `from` as a session id. That bogus id was
 *   then re-fed to `hermes resume` on every subsequent run, generating a
 *   runaway adapter_failed loop that stranded the assigned issue.
 *
 * These tests assert the fix: any captured id must pass the canonical
 * Hermes shape check (^\d{8}_\d{6}_[a-f0-9]+$) OR be rejected by
 * isPlausibleSessionId(). No English stopword may ever be persisted as a
 * session id, and no malformed prevSessionId may reach `hermes resume`.
 *
 * Originally authored as a zero-dependency node:test harness in the
 * in-place dist patch (RUAAAAA-2033, file test/parseHermesOutput.test.js);
 * ported to vitest + TypeScript here so it runs in CI upstream and tests
 * the real exported helper instead of the eval-from-dist hack.
 */

import { describe, it, expect } from "vitest";
import { isPlausibleSessionId, SESSION_ID_REGEX_LEGACY } from "../src/server/execute.js";

/** Inlined copy of the legacy parse branch — the only branch that ever
 *  produced the bug. Stays in lockstep with parseHermesOutput() in
 *  src/server/execute.ts. */
function parseLegacySessionId(combined: string): {
  sessionId: string | undefined;
  warning: { kind: string; captured: string; reason: string } | null;
} {
  const m = combined.match(SESSION_ID_REGEX_LEGACY);
  if (!m?.[1]) return { sessionId: undefined, warning: null };
  if (isPlausibleSessionId(m[1])) return { sessionId: m[1], warning: null };
  return {
    sessionId: undefined,
    warning: {
      kind: "session_id_rejected",
      captured: m[1],
      reason: "failed_canonical_shape_check",
    },
  };
}

/** Stopwords mirror of SESSION_ID_STOPWORDS in src/server/execute.ts. Used
 *  to drive the sweep test without exporting the constant. */
const SESSION_ID_STOPWORDS = new Set([
  "from", "with", "for", "to", "in", "of", "on", "at", "by", "an", "a", "the",
  "is", "it", "as", "or", "and", "use", "list", "previous", "cli", "run",
  "session", "id", "saved", "please",
]);

describe("RUAAAAA-1977 regression: parseHermesOutput legacy session id", () => {
  it("rejects the literal word `from` leaked from the Hermes CLI help text", () => {
    // Exact stderr string observed on RUAAAAA-1960 (run fffeda20, 2026-06-19).
    // The pre-fix SESSION_ID_REGEX_LEGACY matched the phrase
    //   "Use a session ID from a previous CLI run"
    // and captured the literal word `from`. The fix tightens the regex to
    // require a colon/equals-delimited key, so the help text no longer
    // matches at all. Result: no capture, no sessionId, no warning.
    const stderr = [
      "[hermes] Resuming session: from",
      "Session not found: from",
      "Use a session ID from a previous CLI run (hermes sessions list).",
      "[hermes] Exit code: 1",
    ].join("\n");
    const r = parseLegacySessionId("\n" + stderr);
    expect(r.sessionId).toBeUndefined();
    // Verify the legacy regex no longer matches the help text. If the
    // regex is ever loosened again, this test will fail loudly.
    expect(
      SESSION_ID_REGEX_LEGACY.test(
        "Use a session ID from a previous CLI run (hermes sessions list).",
      ),
    ).toBe(false);
  });

  it("emits a session_id_rejected warning when the regex matches a non-canonical value", () => {
    // A hypothetical run where stdout contains a literal `session_id: from`
    // — this could only happen if a previous run already corrupted the
    // sessionParams. The fix path is: regex matches, but the captured value
    // fails the canonical shape check, so the warning fires and sessionId
    // is dropped.
    const combined = "session_id: from";
    const r = parseLegacySessionId(combined);
    expect(r.sessionId).toBeUndefined();
    expect(r.warning).not.toBeNull();
    expect(r.warning?.kind).toBe("session_id_rejected");
    expect(r.warning?.captured).toBe("from");
    expect(r.warning?.reason).toBe("failed_canonical_shape_check");
  });

  it("accepts a real canonical session id `20260619_110651_dea627`", () => {
    const combined = [
      "Some Hermes response text here.",
      "",
      "session_id: 20260619_110651_dea627",
    ].join("\n");
    const r = parseLegacySessionId(combined);
    expect(r.sessionId).toBe("20260619_110651_dea627");
    expect(r.warning).toBeNull();
  });

  it("rejects the truncated suffix `20260619_110651_` observed on RUAAAAA-1960 run 5e599a1b", () => {
    // The literal captured value when the legacy regex matched
    // `session_id: 20260619_110651_` (suffix stripped by an earlier bug).
    const combined = "session_id: 20260619_110651_";
    const r = parseLegacySessionId(combined);
    expect(r.sessionId).toBeUndefined();
    expect(r.warning).not.toBeNull();
    expect(r.warning?.captured).toBe("20260619_110651_");
  });

  it("rejects every English stopword that could leak from CLI help text", () => {
    for (const word of SESSION_ID_STOPWORDS) {
      expect(
        isPlausibleSessionId(word),
        `stopword '${word}' must be rejected as a session id`,
      ).toBe(false);
    }
  });

  it("rejects non-string, empty, and clearly-malformed inputs", () => {
    expect(isPlausibleSessionId(undefined)).toBe(false);
    expect(isPlausibleSessionId("")).toBe(false);
    expect(isPlausibleSessionId(null)).toBe(false);
    expect(isPlausibleSessionId(42)).toBe(false);
    // Looks session-ish but is the wrong shape: must be refused.
    expect(isPlausibleSessionId("not-a-real-id")).toBe(false);
    expect(isPlausibleSessionId("20260619_110651_GARBAGE")).toBe(false);
  });

  it("accepts every character of a real canonical id, not just the prefix", () => {
    expect(isPlausibleSessionId("20260619_110651_dea627")).toBe(true);
    expect(isPlausibleSessionId("20260619_110651_a")).toBe(true);
    // The first 12 chars of a real id are NOT a valid id by themselves.
    expect(
      isPlausibleSessionId("20260619_110651"),
      "truncated prefix (no _<hex> suffix) must be rejected",
    ).toBe(false);
  });
});

describe("RUAAAAA-1977 regression: --resume runtime guard contract", () => {
  // The guard logic is exercised in the integration path, but its contract is
  // "any non-plausible prevSessionId is dropped before args.push('--resume', ...)".
  // That contract is equivalent to: prevSessionIdUsedInArgs === isPlausibleSessionId(prevSessionId)
  // so we just exercise the predicate on the exact values observed in the wild.
  it("rejects every value that previously reached `hermes resume`", () => {
    const observed = [
      "from",                          // fffeda20, 4230e814, 565d5395, 55afbfbc, 2026-06-14 set
      "20260619_110651_",              // 5e599a1b (truncated)
      "20260614_165932_",              // 2026-06-14 set
      "20260614_170614_",              // 2026-06-14 set
    ];
    for (const v of observed) {
      expect(
        isPlausibleSessionId(v),
        `historical bad id '${v}' must now be rejected by the resume guard`,
      ).toBe(false);
    }
  });
});