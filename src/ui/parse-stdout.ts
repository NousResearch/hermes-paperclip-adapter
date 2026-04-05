/**
 * Parse Hermes Agent stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * Hermes CLI output patterns:
 *   Assistant:   "  ┊ 💬 {text}"
 *   Thinking:    "  ┊ 💭 {text}"
 *   Tool start:  "  [tool] (｡◕‿◕｡) 💻 $   curl -s \"...\""
 *   Tool done:   "  ┊ 💻 $   curl -s \"...\"  0.1s"
 *   Tool done:   "  [done] ┊ 💻 $   curl -s \"...\"  0.1s (0.5s)"
 *   System:      "[hermes] ..."
 *
 * We emit tool_call when a [tool] start line appears, then emit the matching
 * tool_result when the completion line arrives. If a completion line arrives
 * without a pending start line (for example in quiet mode), we synthesize both
 * entries from that single line as a fallback.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

/**
 * Strip kawaii faces and decorative emoji from a tool summary line.
 * Leaves meaningful emoji (💻 for terminal, 🔍 for search, etc.) intact
 * by only stripping parenthesized kaomoji like (｡◕‿◕｡).
 */
function stripKaomoji(text: string): string {
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

function stripFramePrefix(line: string): string {
  let cleaned = line.trim().replace(/^\[done\]\s*/, "").replace(/^\[tool\]\s*/, "");
  if (cleaned.startsWith(TOOL_OUTPUT_PREFIX)) {
    cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  }
  return stripKaomoji(cleaned).trim();
}

function isEmojiToken(token: string): boolean {
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(token);
}

// ── Line classification ────────────────────────────────────────────────────

/** Check if a ┊ line is an assistant message (┊ 💬 ...). */
function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

/** Extract assistant text from a ┊ 💬 line. */
function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

function isPipeOutputLine(trimmed: string): boolean {
  return (
    trimmed.startsWith(TOOL_OUTPUT_PREFIX) ||
    /^\[done\]\s*┊/.test(trimmed)
  );
}

function isSpinnerNoiseLine(line: string): boolean {
  const stripped = stripFramePrefix(line);
  return /^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(stripped);
}

// ── Tool parsing ───────────────────────────────────────────────────────────

interface ParsedToolLine {
  name: string;
  detail: string;
  duration: string;
  hasError: boolean;
}

const TOOL_NAME_MAP: Record<string, string> = {
  "$": "shell",
  exec: "shell",
  terminal: "shell",
  search: "search",
  fetch: "fetch",
  crawl: "crawl",
  navigate: "browser",
  snapshot: "browser",
  click: "browser",
  type: "browser",
  scroll: "browser",
  back: "browser",
  press: "browser",
  close: "browser",
  images: "browser",
  vision: "browser",
  read: "read",
  write: "write",
  patch: "patch",
  grep: "search",
  find: "search",
  plan: "plan",
  recall: "recall",
  proc: "process",
  delegate: "delegate",
  todo: "todo",
  memory: "memory",
  clarify: "clarify",
  session_search: "recall",
  code: "execute",
  execute: "execute",
  web_search: "search",
  web_extract: "fetch",
  browser_navigate: "browser",
  browser_click: "browser",
  browser_type: "browser",
  browser_snapshot: "browser",
  browser_vision: "browser",
  browser_scroll: "browser",
  browser_press: "browser",
  browser_back: "browser",
  browser_close: "browser",
  browser_get_images: "browser",
  read_file: "read",
  write_file: "write_file",
  search_files: "search",
  patch_file: "patch",
  execute_code: "execute",
};

const MAX_TOOL_DETAIL_CHARS = 180;

function normalizeToolDetail(detail: string): string {
  return detail
    .replace(/\s+/g, " ")
    .replace(/\s*\[(?:exit \d+|error|full)\]\s*$/i, "")
    .trim();
}

function compactToolDetail(detail: string): string {
  const normalized = normalizeToolDetail(detail)
    .replace(/python3\s+-c\s+(['"]).*$/i, "python3 -c <inline script>")
    .replace(/python3\s+-m\s+json\.tool\b.*$/i, "python3 -m json.tool")
    .replace(/<<'?[A-Z0-9_]*'?\s*$/i, "<<'PY'")
    .replace(/\bhttps?:\/\/[^\s"']{80,}/g, (url) => `${url.slice(0, 77)}…`);

  if (normalized.length <= MAX_TOOL_DETAIL_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…`;
}

function parseToolLine(
  line: string,
  options: { parseDuration?: boolean } = {},
): ParsedToolLine | null {
  const cleaned = stripFramePrefix(line);
  if (!cleaned) return null;
  if (cleaned.startsWith("💬") || cleaned.startsWith("💭")) return null;

  const durationMatch = options.parseDuration
    ? cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/)
    : null;
  const duration = durationMatch?.[1] ?? "";
  const withoutDuration = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;

  const hasError =
    /\[(?:exit \d+|error|full)\]\s*$/i.test(withoutDuration) ||
    /\[error\]\s*$/i.test(cleaned);

  const tokens = withoutDuration.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let verb = tokens[0];
  let detailTokens = tokens.slice(1);

  if (tokens.length >= 2 && isEmojiToken(tokens[0])) {
    verb = tokens[1];
    detailTokens = tokens.slice(2);
  }

  const detail = detailTokens.join(" ").trim();
  const name = TOOL_NAME_MAP[verb.toLowerCase()] || verb;

  return { name, detail, duration, hasError };
}

// ── Synthetic tool ID generation + pending tool tracking ───────────────────

let toolCallCounter = 0;

interface PendingToolCall {
  id: string;
  name: string;
  detail: string;
}

const pendingToolCalls: PendingToolCall[] = [];

/**
 * Generate a synthetic toolUseId for pairing tool_call with tool_result.
 * Paperclip uses this to match them in normalizeTranscript.
 */
function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

function clearPendingToolCalls(): void {
  pendingToolCalls.length = 0;
}

function enqueuePendingToolCall(name: string, detail: string): string {
  const id = syntheticToolUseId();
  pendingToolCalls.push({ id, name, detail: normalizeToolDetail(detail) });
  return id;
}

function takePendingToolCall(name: string, detail: string): string | undefined {
  if (pendingToolCalls.length === 0) return undefined;

  const normalizedDetail = normalizeToolDetail(detail);
  const exactIdx = pendingToolCalls.findIndex(
    (pending) =>
      pending.name === name &&
      (pending.detail === normalizedDetail ||
        pending.detail.startsWith(normalizedDetail) ||
        normalizedDetail.startsWith(pending.detail)),
  );

  const idx = exactIdx >= 0 ? exactIdx : 0;
  return pendingToolCalls.splice(idx, 1)[0]?.id;
}

// ── Thinking detection ─────────────────────────────────────────────────────

function isThinkingLine(line: string): boolean {
  const stripped = stripFramePrefix(line);
  return (
    stripped.startsWith("💭") ||
    stripped.startsWith("<thinking>") ||
    stripped.startsWith("</thinking>") ||
    stripped.startsWith("Thinking:")
  );
}

function extractThinkingText(line: string): string {
  return stripFramePrefix(line).replace(/^💭\s*/, "").trim();
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a single line of Hermes stdout into transcript entries.
 *
 * Emits structured tool_call and tool_result entries so Paperclip renders
 * progress incrementally instead of collapsing everything into raw stdout.
 *
 * @param line  Raw stdout line from Hermes CLI
 * @param ts    ISO timestamp for the entry
 * @returns     Array of TranscriptEntry objects (may be empty)
 */
export function parseHermesStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // ── System/adapter messages ────────────────────────────────────────────
  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    if (trimmed.startsWith("[hermes] Starting Hermes Agent")) {
      clearPendingToolCalls();
    }
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── MCP / server init noise reclassified from stderr by wrappedOnLog ──
  // Pattern: [2026-03-25T10:40:53.941Z] INFO: ...
  // Emit as stderr so Paperclip groups them into the amber accordion.
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Session info line ────────────────────────────────────────────────
  if (trimmed.startsWith("session_id:")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Standalone spinner remnants: "💻 Completed", "┊ 💻 Completed", etc. ─
  if (isSpinnerNoiseLine(trimmed)) {
    return [];
  }

  // ── Thinking blocks ────────────────────────────────────────────────────
  // Detect before generic ┊ parsing so ┊ 💭 lines do not degrade to stdout.
  if (isThinkingLine(trimmed)) {
    return [
      {
        kind: "thinking",
        ts,
        text: extractThinkingText(trimmed),
      },
    ];
  }

  // ── Non-quiet mode tool start lines: [tool] (kaomoji) emoji verb ... ───
  if (trimmed.startsWith("[tool]")) {
    const toolInfo = parseToolLine(trimmed);
    if (!toolInfo) return [];

    const toolUseId = enqueuePendingToolCall(toolInfo.name, toolInfo.detail);
    return [
      {
        kind: "tool_call",
        ts,
        name: toolInfo.name,
        input: { detail: compactToolDetail(toolInfo.detail) },
        toolUseId,
      },
    ];
  }

  // ── Quiet/non-quiet completion + assistant lines (prefixed with ┊) ────
  if (isPipeOutputLine(trimmed)) {
    // Assistant message: ┊ 💬 {text}
    if (isAssistantToolLine(trimmed)) {
      return [{ kind: "assistant", ts, text: extractAssistantText(trimmed) }];
    }

    // Tool completion: ┊ {emoji} {verb} {detail} {duration}
    const toolInfo = parseToolLine(trimmed, { parseDuration: true });
    if (toolInfo) {
      const toolUseId = takePendingToolCall(toolInfo.name, toolInfo.detail);
      const compactDetail = compactToolDetail(toolInfo.detail);
      const detailText = toolInfo.duration
        ? `${compactDetail}  ${toolInfo.duration}`
        : compactDetail;

      if (toolUseId) {
        return [
          {
            kind: "tool_result",
            ts,
            toolUseId,
            content: detailText,
            isError: toolInfo.hasError,
          },
        ];
      }

      const fallbackToolUseId = syntheticToolUseId();
      return [
        {
          kind: "tool_call",
          ts,
          name: toolInfo.name,
          input: { detail: compactToolDetail(toolInfo.detail) },
          toolUseId: fallbackToolUseId,
        },
        {
          kind: "tool_result",
          ts,
          toolUseId: fallbackToolUseId,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ];
    }

    // Fallback: raw ┊ line that doesn't match tool format
    return [{ kind: "stdout", ts, text: stripFramePrefix(trimmed) }];
  }

  // ── Error output ───────────────────────────────────────────────────────
  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Regular assistant output ───────────────────────────────────────────
  return [{ kind: "assistant", ts, text: trimmed }];
}
