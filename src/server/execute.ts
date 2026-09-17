/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#wakeReason}}
Wake reason: {{wakeReason}}
{{/wakeReason}}

{{#commentId}}
## 🚨 USER MESSAGE — THIS IS YOUR NEW TASK

You were woken by a comment from the user (@ficho12 / Board). Their message IS your new
highest-priority task. DROP any automated workflow or routine — do what the user asks
BEFORE anything else. Only after fully addressing the user's request should you consider
resuming any routine workflow.

Read the user's message:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Read ALL recent comments too (the user may have left multiple messages):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments?limit=10" | python3 -c "import sys,json; [print(c['authorName'],':',c['body'][:200]) for c in json.load(sys.stdin) if c.get('authorType')=='user']"\`

DO what the user asked. If you need clarification, POST a reply comment. When done,
post a reply comment summarizing what you did.
{{/commentId}}

{{#taskId}}
## Background Task (routine)

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow (only if no user message above)

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"title\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  // Paperclip 2026.513.0+ puts task context in ctx.context, adapter config in ctx.config.
  // Fall back to ctx.config for backwards compatibility with older versions.
  const taskCtx = (ctx.context ?? ctx.config ?? {}) as Record<string, unknown>;

  const taskId = cfgString(taskCtx.taskId);
  const taskTitle = cfgString(taskCtx.taskTitle) || "";
  const taskBody = cfgString(taskCtx.paperclipTaskMarkdown) || cfgString(taskCtx.taskBody) || "";
  const commentId = cfgString(taskCtx.commentId) || "";
  const wakeReason = cfgString(taskCtx.wakeReason) || "";
  const companyName = cfgString(taskCtx.companyName) || "";
  const projectName = cfgString(taskCtx.projectName) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
  };

  // Handle conditional sections: {{#key}}...{{/key}}
  let rendered = template;

  // {{#commentId}}...{{/commentId}} — user comment (HIGHEST priority, process first)
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  // {{#wakeReason}}...{{/wakeReason}} — include if wake reason known
  rendered = rendered.replace(
    /\{\{#wakeReason\}\}([\s\S]*?)\{\{\/wakeReason\}\}/g,
    wakeReason ? "$1" : "",
  );

  // {{#taskId}}...{{/taskId}} — include if task is assigned
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}} — include if no task
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );

  // Replace remaining {{variable}} placeholders
  return renderTemplate(rendered, vars);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

export interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
  terminalFailure?: boolean;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

// Hermes prints provider failures on stdout and may still exit with code 0.
// Keep those diagnostics out of summaries so a real fallback response remains
// distinguishable from a terminal provider failure.
const PROVIDER_DIAGNOSTIC_LINE_RE =
  /^(?:[^\p{L}\p{N}\s]+\s*)?(?:Auxiliary title generation failed|API call failed|Provider:|Error:\s*HTTP\s+\d{3}|Details:|Billing or credits exhausted|Primary model failed|Authentication failed|Rate limited|Final error:|allowance(?:\s|$))/iu;

const TERMINAL_PROVIDER_FAILURE_RE =
  /(?:API call failed after \d+ retries|Rate limited after \d+ retries|Final error:\s*HTTP\s+\d{3})/i;

function isProviderDiagnosticLine(line: string): boolean {
  return PROVIDER_DIAGNOSTIC_LINE_RE.test(line.trim());
}

function lastTerminalProviderFailure(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (TERMINAL_PROVIDER_FAILURE_RE.test(line)) last = line.trim();
  }
  return last;
}

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (isProviderDiagnosticLine(t)) return false;
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
// Banner-only stale-session detection (BOO-456)
// ---------------------------------------------------------------------------

/**
 * Startup banner markers. A stale resumed session prints the startup banner
 * (quiet mode normally suppresses it — its presence signals the stale path),
 * then exits without loading current instructions/skills or doing any work.
 */
const STARTUP_BANNER_HEADER_RE = /hermes agent\s+v?[\d.]/i;
const STARTUP_BANNER_LIST_RE = /available (tools|skills)/i;

/**
 * Tool-call markers in raw stdout that prove a run actually did work.
 * A productive run has at least one of these; a banner-only run has none.
 */
const TOOL_ACTIVITY_RES = [
  /^\s*\[tool\]/m, // non-quiet tool start lines
  /^\s*\[done\]\s*┊/m, // pipe-mode tool completion lines
  /tool_call|tool_use|tool_result|toolResult/i,
  /<tool_call>|<tool_use>|<tool_result>/i,
  /(?:calling|invoking|running)\s+(?:the\s+)?tool/i,
];

function hasToolActivity(stdout: string): boolean {
  if (TOOL_ACTIVITY_RES.some((re) => re.test(stdout))) return true;
  // Quiet-mode tool lines: "┊ {emoji} {verb} ..." — but NOT "┊ 💬 {assistant}".
  // (A negative-lookahead regex is unreliable here because \s* can backtrack
  // past the space between ┊ and 💬; check per-line instead.)
  return stdout.split("\n").some((line) => {
    const t = line.trim();
    if (!t.startsWith("┊")) return false;
    return !t.slice(1).trimStart().startsWith("💬");
  });
}

function isStartupBanner(text: string): boolean {
  const t = text.toLowerCase();
  return STARTUP_BANNER_HEADER_RE.test(t) && STARTUP_BANNER_LIST_RE.test(t);
}

/**
 * Detect the stale-session fingerprint (BOO-454): a resumed run whose output
 * is empty or consists only of the Hermes startup banner, with zero tool calls
 * and no substantive content after cleaning. Such runs must NOT persist their
 * session — the next run should start fresh so it loads current instructions
 * and skills instead of looping on the broken resumed session.
 *
 * Exported for verification/testing (AC5).
 */
export function isBannerOnlyRun(
  stdout: string,
  response: string | undefined,
): boolean {
  // Any tool activity means the run did real work — keep the session.
  if (hasToolActivity(stdout)) return false;

  const resp = (response ?? "").trim();
  // Empty response with no tool calls, or banner-text-only response.
  return resp.length === 0 || isStartupBanner(resp);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

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

  // Hermes reports exhausted credits/rate limits on stdout and can still
  // return exit code 0. A terminal marker with no substantive response is a
  // failed run; an actual fallback response remains successful.
  const terminalFailure =
    lastTerminalProviderFailure(stdout) ?? lastTerminalProviderFailure(stderr);
  if (terminalFailure && !result.response) {
    result.errorMessage = terminalFailure;
    result.terminalFailure = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  // BOO-456: drop the session of banner-only resumed runs so the next run
  // starts fresh (stale sessions loop forever otherwise). Default: on.
  const freshSessionOnBannerOnly =
    cfgBoolean(config.freshSessionOnBannerOnly) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config);

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Session resume — SKIP when a user comment triggered this wake.
  // Resuming a routine-heavy session drowns the user message (Pattern M).
  // Fresh session ensures the 🚨 USER MESSAGE block takes full priority.
  // NOTE: commentId is in ctx.context (Paperclip 2026.513.0+) with ctx.config fallback.
  const taskCtxForResume = (ctx.context ?? ctx.config ?? {}) as Record<string, unknown>;
  const hasComment = cfgString(taskCtxForResume.commentId);
  const prevSessionId = hasComment
    ? undefined
    : cfgString((ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId);
  if (persistSession && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if ((ctx as any).authToken && !env.PAPERCLIP_API_KEY)
    env.PAPERCLIP_API_KEY = (ctx as any).authToken;
  const taskId = cfgString(ctx.config?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(env, userEnv);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: wrappedOnLog,
  });

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    // Hermes' wrapper may swallow provider failures and exit 0. Convert only
    // the high-confidence terminal failure marker; ordinary stderr warnings
    // retain the child process exit code.
    exitCode: parsed.terminalFailure && result.exitCode === 0 ? 1 : result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // BOO-456: banner-only resumed runs (stale-session fingerprint) must NOT
  // persist their session — the next run for this issue starts fresh and
  // loads current instructions/skills instead of looping on the broken
  // session. Productive resumed runs keep persisting exactly as before.
  const dropBannerOnlySession =
    freshSessionOnBannerOnly &&
    prevSessionId !== undefined &&
    isBannerOnlyRun(result.stdout || "", parsed.response);

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    if (dropBannerOnlySession) {
      await ctx.onLog(
        "stdout",
        "[hermes] Banner-only resumed run detected (BOO-456) — session NOT persisted; next run starts fresh\n",
      );
    } else {
      executionResult.sessionParams = { sessionId: parsed.sessionId };
      executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
    }
  }

  // Surface the drop decision in resultJson so the board can verify AC1/AC5.
  executionResult.resultJson = {
    ...(executionResult.resultJson || {}),
    session_dropped_banner_only: dropBannerOnlySession || null,
  };

  return executionResult;
}
