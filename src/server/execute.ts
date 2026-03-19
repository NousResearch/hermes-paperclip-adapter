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
 *   -v/--verbose        verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             skip all permission prompts (required for localhost curl)
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

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

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

function parseObject(v: unknown): Record<string, unknown> {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Session-ID validation
// ---------------------------------------------------------------------------

/**
 * Valid Hermes session IDs follow the pattern: YYYYMMDD_HHMMSS_<alphanum>
 * Invalid session IDs cause "Session not found" infinite loops.
 */
const HERMES_SESSION_ID_REGEX = /^\d{8}_\d{6}_[a-zA-Z0-9]+$/;

function isValidSessionId(id: string | undefined): id is string {
  return id != null && HERMES_SESSION_ID_REGEX.test(id);
}

// ---------------------------------------------------------------------------
// AGENTS.md injection
// ---------------------------------------------------------------------------

/**
 * Reads the AGENTS.md file for the given agent from the workspace directory.
 * Tries several name variants (exact, lowercase, kebab-case) to find the file.
 * This mirrors Claude's --append-system-prompt-file behavior.
 */
function loadAgentsMd(agentName: string, workspaceCwd: string): string {
  if (!agentName || !workspaceCwd) return "";

  const candidates = [
    agentName,
    agentName.toLowerCase(),
    agentName.toLowerCase().replace(/\s+/g, "-"),
    agentName.toLowerCase().replace(/[.\s]+/g, "-"),
  ];

  for (const name of candidates) {
    const agentsFile = resolve(workspaceCwd, "agents", name, "AGENTS.md");
    try {
      if (existsSync(agentsFile)) {
        return readFileSync(agentsFile, "utf8").trim();
      }
    } catch {
      // Permission error or similar — skip this candidate
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Model auto-detection from Hermes config.yaml
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser for the `model:` section of a Hermes config.yaml.
 * Extracts `default`, `provider`, and `base_url` fields without requiring
 * a full YAML library.
 */
function parseYamlModelSection(content: string): Record<string, string> {
    const lines = content.split("\n");
    const result: Record<string, string> = {};
    let inModelSection = false;
    let modelIndent = 0;
    for (const line of lines) {
        if (/^model:\s*$/.test(line)) { inModelSection = true; modelIndent = 0; continue; }
        if (inModelSection) {
            if (/^[a-zA-Z]/.test(line) && !line.startsWith(" ")) break;
            const nestedMatch = line.match(/^(\s+)(default|provider|base_url):\s*(.+)$/);
            if (nestedMatch) {
                const [, indent, key, value] = nestedMatch;
                if (modelIndent === 0) modelIndent = indent.length;
                if (indent.length === modelIndent) result[key] = value.trim().replace(/^['"]|['"]$/g, "");
            }
        }
    }
    return result;
}

/**
 * Detects the HERMES_HOME directory for a given Hermes command by reading
 * wrapper scripts (e.g. `hermes-grok`, `hermes-35b`) that set HERMES_HOME.
 * Falls back to `~/.hermes`.
 */
function detectHermesHome(hermesCmd: string): string {
    try {
        if (hermesCmd && hermesCmd !== HERMES_CLI) {
            const cmdPaths = [
                resolve("/usr/local/bin", hermesCmd),
                resolve(homedir(), ".local", "bin", hermesCmd),
                resolve(homedir(), "bin", hermesCmd),
            ];
            for (const cmdPath of cmdPaths) {
                if (existsSync(cmdPath)) {
                    const script = readFileSync(cmdPath, "utf8");
                    const match = script.match(/HERMES_HOME\s*=\s*["']?([^"'\s]+)/);
                    if (match?.[1]) return match[1].replace(/\$HOME/g, homedir()).replace(/~/, homedir());
                }
            }
        }
    } catch { /* ignore */ }
    return resolve(homedir(), ".hermes");
}

/**
 * Auto-detects the current model from the Hermes derivat's config.yaml.
 * This avoids using the hardcoded DEFAULT_MODEL (anthropic/claude-sonnet-4)
 * when a local model is configured in the Hermes instance.
 */
function detectCurrentModel(hermesCmd: string): { model: string | null; provider: string | null; baseUrl: string | null } {
    const hermesHome = detectHermesHome(hermesCmd);
    try {
        const configPath = resolve(hermesHome, "config.yaml");
        if (existsSync(configPath)) {
            const content = readFileSync(configPath, "utf8");
            const modelCfg = parseYamlModelSection(content);
            if (modelCfg.default) return { model: modelCfg.default, provider: modelCfg.provider || null, baseUrl: modelCfg.base_url || null };
        }
        const envPath = resolve(hermesHome, ".env");
        if (existsSync(envPath)) {
            const content = readFileSync(envPath, "utf8");
            const match = content.match(/^LLM_MODEL\s*=\s*(.+)$/m);
            if (match?.[1]) return { model: match[1].trim().replace(/^['"]|['"]$/g, ""), provider: null, baseUrl: null };
        }
    } catch { /* ignore */ }
    return { model: null, provider: null, baseUrl: null };
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
2. When done, mark the issue as completed:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Report what you did
{{/taskId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List issues assigned to you:
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}&status=todo" | python3 -m json.tool\`

2. If issues found, pick the highest priority one and work on it:
   - Checkout: \`curl -s -X POST "{{paperclipApiUrl}}/issues/ISSUE_ID/checkout" -H "Content-Type: application/json" -d '{"agentId":"{{agentId}}"}'\`
   - Do the work
   - Complete: \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"status":"done"}'\`

3. If no issues found, check for any unassigned issues:
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -m json.tool\`

4. If truly nothing to do, report briefly.
{{/noTask}}`;

async function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  resolvedCwd: string,
): Promise<string> {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  // ── Resolve task details (Fix 5: Issue-Detail Fetch) ─────────────────
  const resolvedTaskId =
    cfgString(ctx.config?.taskId) || cfgString(ctx.config?.issueId);
  let resolvedTaskTitle =
    cfgString(ctx.config?.taskTitle) || cfgString(ctx.config?.issueTitle) || "";
  let resolvedTaskBody =
    cfgString(ctx.config?.taskBody) || cfgString(ctx.config?.issueBody) || "";

  // Paperclip often sends only issueId without title/body in wake context.
  // Fetch issue details ourselves when they are missing.
  if (resolvedTaskId && (!resolvedTaskTitle || !resolvedTaskBody)) {
    try {
      let apiBase =
        cfgString(config.paperclipApiUrl) ||
        process.env.PAPERCLIP_API_URL ||
        "http://127.0.0.1:3100/api";
      if (!apiBase.endsWith("/api")) {
        apiBase = apiBase.replace(/\/+$/, "") + "/api";
      }
      const issueResp = await fetch(`${apiBase}/issues/${resolvedTaskId}`);
      if (issueResp.ok) {
        const issue = (await issueResp.json()) as Record<string, unknown>;
        resolvedTaskTitle =
          resolvedTaskTitle || cfgString(issue.title as string) || "";
        resolvedTaskBody =
          resolvedTaskBody || cfgString(issue.description as string) || "";
      }
    } catch {
      // Non-fatal: agent can still fetch details itself via curl
    }
  }

  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: resolvedTaskId || "",
    taskTitle: resolvedTaskTitle,
    taskBody: resolvedTaskBody,
    projectName,
    paperclipApiUrl,
  };

  // Handle conditional sections: {{#key}}...{{/key}}
  let rendered = template;

  // {{#taskId}}...{{/taskId}} — include if task is assigned
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    resolvedTaskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}} — include if no task
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    resolvedTaskId ? "" : "$1",
  );

  // Replace remaining {{variable}} placeholders
  let prompt = renderTemplate(rendered, vars);

  // ── AGENTS.md injection (Fix 1) ──────────────────────────────────────
  const agentsFileContent = loadAgentsMd(agentName, resolvedCwd);
  if (agentsFileContent) {
    prompt = agentsFileContent + "\n\n---\n\n" + prompt;
  }

  return prompt;
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

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch[1];
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = stdout.slice(0, sessionLineIdx).trim();
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch[1];
    }
  }

  // Validate extracted session ID (Fix 4)
  if (result.sessionId && !isValidSessionId(result.sessionId)) {
    result.sessionId = undefined;
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
  const config = (ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const configuredModel = cfgString(config.model);
  const detected = detectCurrentModel(hermesCmd);
  const model = configuredModel || detected.model || DEFAULT_MODEL;
  const provider = cfgString(config.provider) || detected.provider;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Resolve working directory ──────────────────────────────────────────
  const resolvedCwd =
    cfgString(config.cwd) ||
    cfgString(parseObject(ctx.context?.paperclipWorkspace).cwd) ||
    cfgString(ctx.config?.workspaceDir) ||
    ".";
  let resolvedCwdAbsolute: string;
  try {
    resolvedCwdAbsolute = await ensureAbsoluteDirectory(resolvedCwd);
  } catch {
    resolvedCwdAbsolute = resolve(resolvedCwd);
  }

  // ── Build prompt (async — may fetch issue details) ─────────────────────
  const prompt = await buildPrompt(ctx, config, resolvedCwdAbsolute);

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  args.push("-m", model);

  // Only pass --provider if it's a valid Hermes provider choice.
  if (provider && (VALID_PROVIDERS as readonly string[]).includes(provider)) {
    args.push("--provider", provider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // ── --yolo flag (Fix 3) ────────────────────────────────────────────────
  // When dangerouslySkipPermissions is enabled, pass --yolo to Hermes CLI.
  // Without this, Hermes' security scanner blocks curl to localhost (127.0.0.1)
  // with exit -1, preventing the agent from communicating with Paperclip API.
  if (cfgBoolean(config.dangerouslySkipPermissions) === true) {
    args.push("--yolo");
  }

  // Session resume — validate session ID format (Fix 4)
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  if (persistSession && isValidSessionId(prevSessionId)) {
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
  const taskId = cfgString(ctx.config?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  // ── TERMINAL_CWD injection (Fix 2) ────────────────────────────────────
  // Hermes Terminal is stateless — each command starts in a new shell.
  // TERMINAL_CWD tells Hermes where to execute commands. Without this,
  // agents start in the wrong directory and get stuck in cd loops.
  env.TERMINAL_CWD = resolvedCwdAbsolute;

  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(env, userEnv);
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, timeout=${timeoutSec}s)\n`,
  );
  if (isValidSessionId(prevSessionId)) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd: resolvedCwdAbsolute,
    env,
    timeoutSec,
    graceSec,
    onLog: ctx.onLog,
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
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: provider || null,
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

  // Store session ID for next run (only if valid format)
  if (persistSession && isValidSessionId(parsed.sessionId)) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  } else if (persistSession && parsed.sessionId) {
    // Invalid session ID extracted — clear it to prevent loops
    executionResult.sessionParams = null;
  }

  return executionResult;
}
