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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function cfgObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function firstCfgString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const resolved = cfgString(value);
    if (resolved) return resolved;
  }
  return undefined;
}

function readNestedString(
  source: Record<string, unknown> | undefined,
  path: string[],
): string | undefined {
  let current: unknown = source;
  for (const segment of path) {
    const object = cfgObject(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return cfgString(current);
}

type DynamicOpenRouterModelSelection = {
  model: string;
  role?: string;
  source?: string;
  free_model_count?: number;
  [key: string]: unknown;
};

const DEFAULT_DYNAMIC_OPENROUTER_FALLBACK_MODEL = "openai/gpt-oss-20b:free";
const DEFAULT_OPENROUTER_FREE_FALLBACK_MODELS = [
  "openai/gpt-oss-20b:free",
  "minimax/minimax-m2.5:free",
  "openai/gpt-oss-120b:free",
];

function isOpenRouterFreeModel(model: string): boolean {
  return model.endsWith(":free") && model !== "openrouter/free";
}

function cfgStringList(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((i) => typeof i === "string")) {
    return (v as string[]).map((i) => i.trim()).filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((i) => i.trim()).filter(Boolean);
  }
  return undefined;
}

function openRouterFreeFallbackModels(
  config: Record<string, unknown>,
  currentModel: string,
): string[] {
  const configured = [
    ...(cfgStringList(config.openrouterFreeFallbackModels) || []),
    cfgString(config.dynamicFreeModelFallbackModel) || "",
    cfgString(config.openrouterMalformedHeaderFallbackModel) || "",
  ].filter(Boolean);
  const candidates = configured.length
    ? configured
    : [
        ...DEFAULT_OPENROUTER_FREE_FALLBACK_MODELS,
        DEFAULT_DYNAMIC_OPENROUTER_FALLBACK_MODEL,
      ];
  const seen = new Set<string>([currentModel]);
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!isOpenRouterFreeModel(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function inferOpenRouterRole(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const configured = cfgString(config.openrouterRole) || cfgString(config.roleKey);
  if (configured) return configured;

  const name = String(ctx.agent?.name || "").toLowerCase();
  if (name.includes("research")) return "researcher";
  if (name.includes("analytic")) return "analytics";
  if (name.includes("engineer")) return "engineer";
  if (name === "qa" || name.includes("qa")) return "qa";
  if (name.includes("writer")) return "writer";
  if (name.includes("market")) return "marketer";
  if (name.includes("sales")) return "sales";
  if (name.includes("support")) return "support";
  if (name.includes("youtube") || name.includes("video")) return "youtube";
  return "default";
}

function hasOpenInferenceMalformedHeaderFailure(result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}): boolean {
  if (result.timedOut || result.exitCode === 0) return false;
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  return (
    /Upstream error from OpenInference/i.test(combined) &&
    /unexpected tokens remaining in message header/i.test(combined)
  );
}

function childFailed(result: {
  exitCode?: number | null;
  timedOut?: boolean;
}): boolean {
  return Boolean(result.timedOut || (typeof result.exitCode === "number" && result.exitCode !== 0));
}

function setArgValue(args: string[], flag: string, value: string): void {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) {
    args[idx + 1] = value;
    return;
  }
  args.push(flag, value);
}

async function resolveDynamicOpenRouterModel(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  currentModel: string,
): Promise<DynamicOpenRouterModelSelection> {
  const selector =
    cfgString(config.openrouterModelSelector) ||
    "/mnt/d/AiMe/scripts/paperclip_select_openrouter_free_model.py";
  const role = inferOpenRouterRole(ctx, config);
  const maxAgeHours = String(cfgNumber(config.dynamicFreeModelMaxAgeHours) || 6);
  const { stdout } = await execFileAsync(
    selector,
    [
      "--role",
      role,
      "--current",
      currentModel,
      "--max-age-hours",
      maxAgeHours,
      "--json",
    ],
    {
      timeout: 150000,
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as DynamicOpenRouterModelSelection;
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (!model) {
    throw new Error("OpenRouter selector returned no model");
  }
  return { ...parsed, model };
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

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. Before marking the issue done, verify every artifact path you plan to mention actually exists. Use commands like \`test -f /absolute/path\` or \`ls -la /absolute/path\`.
3. If a requested artifact is missing, do not mark the issue done. Leave the issue in progress or blocked and comment with the missing path and what is needed.
4. When done, mark the issue as completed with a single PATCH that includes structured evidence:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done","comment":"DONE: <summary>\\n\\nCompletion evidence:\\n- Artifacts: <absolute paths you verified, or none required>\\n- Verification: <commands/checks run>\\n- Human decision needed: <none, or SEND / EDIT-FIRST / SKIP / other decision>"}'\`
5. If a human must choose SEND / EDIT-FIRST / SKIP, publish, buy, approve, or provide access, keep that explicit in the completion evidence so dashboards route it as a manual decision instead of final signoff.
6. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress, blocked):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}&status=todo,backlog,in_progress,blocked" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

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

  const context = cfgObject(ctx.context);
  const payload = cfgObject(context?.payload);
  const issue = cfgObject(context?.issue);
  const wakeComment = cfgObject(context?.wakeComment);

  const taskId = firstCfgString(
    ctx.config?.taskId,
    context?.taskId,
    context?.issueId,
    payload?.taskId,
    payload?.issueId,
    issue?.id,
  );
  const taskTitle = firstCfgString(ctx.config?.taskTitle, issue?.title) || "";
  const taskBody = firstCfgString(ctx.config?.taskBody, issue?.description) || "";
  const commentId = firstCfgString(
    ctx.config?.commentId,
    context?.commentId,
    context?.wakeCommentId,
    payload?.commentId,
    wakeComment?.id,
  ) || "";
  const wakeReason = firstCfgString(
    ctx.config?.wakeReason,
    context?.wakeReason,
    context?.reason,
  ) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = firstCfgString(
    ctx.config?.companyName,
    readNestedString(context, ["company", "name"]),
  ) || "";
  const projectName = firstCfgString(
    ctx.config?.projectName,
    readNestedString(context, ["project", "name"]),
  ) || "";

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

  // {{#commentId}}...{{/commentId}} — include if comment exists
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
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

interface ParsedOutput {
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
function cleanResponse(raw: string): string {
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

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
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
  let model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
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
  let dynamicOpenRouterModel: DynamicOpenRouterModelSelection | null = null;

  if (explicitProvider === "openrouter" && cfgBoolean(config.dynamicFreeModel) !== false) {
    try {
      dynamicOpenRouterModel = await resolveDynamicOpenRouterModel(ctx, config, model);
      model = dynamicOpenRouterModel.model;
    } catch (err) {
      await ctx.onLog(
        "stderr",
        `[hermes] OpenRouter dynamic model selection failed; using configured model ${model}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

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

  // Session resume
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
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
  const context = cfgObject(ctx.context);
  const payload = cfgObject(context?.payload);
  const issue = cfgObject(context?.issue);
  const taskId = firstCfgString(
    ctx.config?.taskId,
    context?.taskId,
    context?.issueId,
    payload?.taskId,
    payload?.issueId,
    issue?.id,
  );
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(env, userEnv);
  }
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;
  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

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
  if (dynamicOpenRouterModel) {
    await ctx.onLog(
      "stdout",
      `[hermes] OpenRouter free model selected (role=${dynamicOpenRouterModel.role ?? "default"}, model=${dynamicOpenRouterModel.model}, source=${dynamicOpenRouterModel.source ?? "unknown"}, free_models=${dynamicOpenRouterModel.free_model_count ?? "unknown"})\n`,
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

  let finalProvider = resolvedProvider;
  let result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: wrappedOnLog,
  });

  if (dynamicOpenRouterModel && childFailed(result)) {
    const retryArgs = [...args];
    const fallbackModels = openRouterFreeFallbackModels(config, model);
    for (const fallbackModel of fallbackModels) {
      if (!childFailed(result)) break;
      const malformedHeaderFailure = hasOpenInferenceMalformedHeaderFailure(result);
      setArgValue(retryArgs, "-m", fallbackModel);
      setArgValue(retryArgs, "--provider", "openrouter");

      await ctx.onLog(
        "stdout",
        malformedHeaderFailure
          ? `[hermes] OpenRouter/OpenInference malformed-header failure on ${model}; retrying with free OpenRouter model ${fallbackModel}\n`
          : `[hermes] OpenRouter free model ${model} failed or timed out; retrying with ${fallbackModel}\n`,
      );
      const previousModel = model;
      model = fallbackModel;
      finalProvider = "openrouter";
      dynamicOpenRouterModel = {
        ...dynamicOpenRouterModel,
        model,
        source: malformedHeaderFailure
          ? "openinference-header-free-fallback"
          : "free-fallback-after-failure",
        fallback_from_model: previousModel,
        fallback_model: fallbackModel,
        fallback_provider: "openrouter",
      };
      result = await runChildProcess(ctx.runId, hermesCmd, retryArgs, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
      });
    }
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
  const noTaskHeartbeatCompletedWithoutFinalResponse =
    !taskId &&
    !result.timedOut &&
    result.exitCode !== 0 &&
    Boolean(parsed.sessionId) &&
    !parsed.response &&
    !parsed.errorMessage;
  const effectiveExitCode = noTaskHeartbeatCompletedWithoutFinalResponse
    ? 0
    : result.exitCode;
  const effectiveResponse = noTaskHeartbeatCompletedWithoutFinalResponse
    ? "No assigned or unassigned work found; no-task heartbeat completed without a final response."
    : parsed.response || "";

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (noTaskHeartbeatCompletedWithoutFinalResponse) {
    await ctx.onLog(
      "stdout",
      "[hermes] Treating empty no-task heartbeat response as idle success.\n",
    );
  }
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: effectiveExitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: finalProvider,
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
  if (effectiveResponse) {
    executionResult.summary = effectiveResponse.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: effectiveResponse,
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
    dynamic_openrouter_model: dynamicOpenRouterModel,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
