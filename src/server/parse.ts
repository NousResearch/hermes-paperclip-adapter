/**
 * Hermes output parsing utilities.
 *
 * Extracted from execute.ts to improve testability and enable session retry
 * logic (Task 4). All parsing concerns live here; execute.ts imports from
 * this module.
 */

import type { UsageSummary } from "@paperclipai/adapter-utils";

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
export const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
export const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

export interface ParsedHermesOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
export function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseHermesOutput(stdout: string, stderr: string): ParsedHermesOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedHermesOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Session error detection
// ---------------------------------------------------------------------------

/** Regex matching Hermes unknown/invalid session error messages. */
const UNKNOWN_SESSION_REGEX =
  /unknown session|session not found|session expired|no conversation found|invalid session/i;

/**
 * Returns true when Hermes stdout/stderr indicates the resumed session is no
 * longer valid. Callers can use this signal to retry without `--resume`.
 */
export function isHermesUnknownSessionError(stdout: string, stderr: string): boolean {
  const combined = stdout + "\n" + stderr;
  return UNKNOWN_SESSION_REGEX.test(combined);
}

// ---------------------------------------------------------------------------
// Max-turns detection
// ---------------------------------------------------------------------------

/** Regex matching Hermes max-turns result messages. */
const MAX_TURNS_REGEX = /max[_ ]?turns?\s*(?:reached|exceeded|limit)|reached\s+(?:the\s+)?max/i;

/**
 * Returns true when Hermes stdout/stderr indicates the run stopped because it
 * hit the configured maximum number of turns.
 */
export function isHermesMaxTurnsResult(stdout: string, stderr: string): boolean {
  const combined = stdout + "\n" + stderr;
  return MAX_TURNS_REGEX.test(combined);
}
