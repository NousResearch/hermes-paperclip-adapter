import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHermesOutput,
  cleanResponse,
  isHermesUnknownSessionError,
  isHermesMaxTurnsResult,
} from "../dist/server/parse.js";

// ---------------------------------------------------------------------------
// parseHermesOutput
// ---------------------------------------------------------------------------

describe("parseHermesOutput", () => {
  it("extracts session ID from quiet mode output", () => {
    const stdout = "Hello, I can help with that.\n\nsession_id: abc-123\n";
    const result = parseHermesOutput(stdout, "");
    assert.equal(result.sessionId, "abc-123");
  });

  it("extracts response text before session_id line", () => {
    const stdout = "Hello world\n\nsession_id: xyz-999\n";
    const result = parseHermesOutput(stdout, "");
    assert.ok(result.response);
    assert.ok(result.response.includes("Hello world"));
    assert.ok(!result.response.includes("session_id:"));
  });

  it("extracts token usage from stdout", () => {
    const stdout =
      "Done.\n\nsession_id: s1\ntokens: 150 input, 42 output\n";
    const result = parseHermesOutput(stdout, "");
    assert.ok(result.usage, "usage should be present");
    assert.equal(result.usage.inputTokens, 150);
    assert.equal(result.usage.outputTokens, 42);
  });

  it("extracts token usage from stderr", () => {
    const stderr = "tokens: 200 input, 80 output";
    const result = parseHermesOutput("session_id: s1\n", stderr);
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 200);
    assert.equal(result.usage.outputTokens, 80);
  });

  it("extracts cost from stdout", () => {
    const stdout = "session_id: s2\ncost: $0.0042\n";
    const result = parseHermesOutput(stdout, "");
    assert.ok(result.costUsd !== undefined);
    assert.ok(Math.abs(result.costUsd - 0.0042) < 1e-9);
  });

  it("extracts cost from stderr using 'spent' keyword", () => {
    const stderr = "spent: 0.012";
    const result = parseHermesOutput("session_id: s3\n", stderr);
    assert.ok(result.costUsd !== undefined);
    assert.ok(Math.abs(result.costUsd - 0.012) < 1e-9);
  });

  it("extracts error messages from stderr", () => {
    const stderr = "Error: something went wrong\n";
    const result = parseHermesOutput("", stderr);
    assert.ok(result.errorMessage);
    assert.ok(result.errorMessage.includes("Error: something went wrong"));
  });

  it("ignores stderr log-level noise when detecting errors", () => {
    const stderr = "INFO: starting up\nDEBUG: verbose output\n";
    const result = parseHermesOutput("", stderr);
    assert.equal(result.errorMessage, undefined);
  });

  it("handles blank stdout and stderr gracefully", () => {
    const result = parseHermesOutput("", "");
    assert.equal(result.sessionId, undefined);
    assert.equal(result.response, undefined);
    assert.equal(result.usage, undefined);
    assert.equal(result.costUsd, undefined);
    assert.equal(result.errorMessage, undefined);
  });

  it("falls back to legacy session ID format", () => {
    const stdout = "Here is the answer.\nsession saved: legacy-id-456\n";
    const result = parseHermesOutput(stdout, "");
    assert.equal(result.sessionId, "legacy-id-456");
  });
});

// ---------------------------------------------------------------------------
// cleanResponse
// ---------------------------------------------------------------------------

describe("cleanResponse", () => {
  it("strips [tool] lines", () => {
    const raw = "[tool] running bash\nHello from assistant\n";
    const cleaned = cleanResponse(raw);
    assert.ok(!cleaned.includes("[tool]"));
    assert.ok(cleaned.includes("Hello from assistant"));
  });

  it("strips [hermes] lines", () => {
    const raw = "[hermes] initializing\nSome response text\n";
    const cleaned = cleanResponse(raw);
    assert.ok(!cleaned.includes("[hermes]"));
    assert.ok(cleaned.includes("Some response text"));
  });

  it("strips [paperclip] lines", () => {
    const raw = "[paperclip] dispatching\nAssistant reply\n";
    const cleaned = cleanResponse(raw);
    assert.ok(!cleaned.includes("[paperclip]"));
    assert.ok(cleaned.includes("Assistant reply"));
  });

  it("strips session_id lines", () => {
    const raw = "Good answer.\nsession_id: abc-123\n";
    const cleaned = cleanResponse(raw);
    assert.ok(!cleaned.includes("session_id:"));
    assert.ok(cleaned.includes("Good answer."));
  });

  it("preserves assistant text", () => {
    const raw = "This is the assistant's answer.\nIt spans multiple lines.\n";
    const cleaned = cleanResponse(raw);
    assert.ok(cleaned.includes("This is the assistant's answer."));
    assert.ok(cleaned.includes("It spans multiple lines."));
  });

  it("strips ISO timestamp bracket lines", () => {
    const raw = "[2024-03-15T12:34:56Z] system event\nReal text\n";
    const cleaned = cleanResponse(raw);
    assert.ok(!cleaned.includes("[2024-03-15T"));
    assert.ok(cleaned.includes("Real text"));
  });

  it("collapses excessive blank lines", () => {
    const raw = "Line one\n\n\n\nLine two\n";
    const cleaned = cleanResponse(raw);
    // should not have 3+ consecutive newlines
    assert.ok(!/\n{3,}/.test(cleaned));
  });
});

// ---------------------------------------------------------------------------
// isHermesUnknownSessionError
// ---------------------------------------------------------------------------

describe("isHermesUnknownSessionError", () => {
  it('detects "unknown session" in stdout', () => {
    assert.equal(isHermesUnknownSessionError("Error: unknown session", ""), true);
  });

  it('detects "session not found" in stderr', () => {
    assert.equal(isHermesUnknownSessionError("", "session not found"), true);
  });

  it('detects "session expired" case-insensitively', () => {
    assert.equal(isHermesUnknownSessionError("Session Expired", ""), true);
  });

  it('detects "no conversation found"', () => {
    assert.equal(isHermesUnknownSessionError("", "no conversation found"), true);
  });

  it('detects "invalid session"', () => {
    assert.equal(isHermesUnknownSessionError("invalid session id provided", ""), true);
  });

  it("returns false for normal output", () => {
    assert.equal(isHermesUnknownSessionError("All done.", "tokens: 10 in, 5 out"), false);
  });

  it("returns false for empty strings", () => {
    assert.equal(isHermesUnknownSessionError("", ""), false);
  });
});

// ---------------------------------------------------------------------------
// isHermesMaxTurnsResult
// ---------------------------------------------------------------------------

describe("isHermesMaxTurnsResult", () => {
  it('detects "max turns reached" in stdout', () => {
    assert.equal(isHermesMaxTurnsResult("max turns reached", ""), true);
  });

  it('detects "max_turns exceeded" in stderr', () => {
    assert.equal(isHermesMaxTurnsResult("", "max_turns exceeded"), true);
  });

  it('detects "reached the max turns" phrasing', () => {
    assert.equal(isHermesMaxTurnsResult("reached the max turns", ""), true);
  });

  it("does not false-positive on help text mentioning --max-turns flag", () => {
    assert.equal(isHermesMaxTurnsResult("use --max-turns to set a limit", ""), false);
  });

  it("is case-insensitive", () => {
    assert.equal(isHermesMaxTurnsResult("MAX TURNS REACHED", ""), true);
  });

  it("returns false for normal output", () => {
    assert.equal(isHermesMaxTurnsResult("Task complete.", ""), false);
  });

  it("returns false for empty strings", () => {
    assert.equal(isHermesMaxTurnsResult("", ""), false);
  });
});
