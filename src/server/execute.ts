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
  FALLBACK_TIERS,
  FALLBACK_ERROR_PATTERNS,
  type FallbackTier,
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
// Spend tracker (in-process, reset on process restart — acceptable for MVP)
// ---------------------------------------------------------------------------

interface DailySpendEntry {
  date: string; // YYYY-MM-DD
  spentUsd: number;
}

class SpendTracker {
  private entries: Map<number, DailySpendEntry> = new Map();

  /**
   * Check if a tier is within its daily spend limit.
   * Returns the remaining budget, or null if no limit.
   */
  getRemainingBudget(tier: FallbackTier): number | null {
    if (tier.dailySpendLimitUsd === null || tier.dailySpendLimitUsd === undefined) {
      return null;
    }
    const key = this.todayKey();
    const entry = this.entries.get(tier.tier);
    const spent = entry?.date === key ? entry.spentUsd : 0;
    return Math.max(0, tier.dailySpendLimitUsd - spent);
  }

  /**
   * Record spend for a tier.
   */
  recordSpend(tier: FallbackTier, costUsd: number): void {
    if (tier.dailySpendLimitUsd === null || tier.dailySpendLimitUsd === undefined) return;
    const key = this.todayKey();
    const entry = this.entries.get(tier.tier);
    const current = entry?.date === key ? entry.spentUsd : 0;
    this.entries.set(tier.tier, { date: key, spentUsd: current + costUsd });
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

/**
 * Select the first available tier for execution.
 * Respects spend limits — skips tiers that have hit their daily cap.
 * @param tiers - the active tier list (may be overridden from config)
 */
function selectInitialTier(spendTracker: SpendTracker, tiers: FallbackTier[]): FallbackTier | null {
  for (const tier of tiers) {
    const remaining = spendTracker.getRemainingBudget(tier);
    if (remaining === null || remaining > 0) {
      return tier;
    }
    // Budget exhausted — try next tier silently
  }
  return null;
}

/**
 * Check whether an error in combined stdout+stderr should trigger
 * fallback to the next tier.
 */
function shouldFallback(tier: FallbackTier, combinedOutput: string): boolean {
  if (!tier.errorPatterns) return false;
  return tier.errorPatterns.some((pattern) => pattern.test(combinedOutput));
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

First, fetch your full task details (title + description):
  \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/{{taskId}}"\`

Read the response JSON — the "title" and "description" fields are your task instructions. Execute accordingly.

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
  \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i["identifier"]} {i["status"]:>12} {i["priority"]:>6} {i["title"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - For code changes: \`cd /root/projects/maximiza-tu-dinero && git checkout main && git pull\` then create a branch, make changes, commit, push, and create a PR (see Workflow above)
   - For non-code tasks: do the work and post findings as a comment
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i["identifier"]} {i["title"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  const taskId = cfgString((ctx as any).context?.taskId ?? (ctx as any).context?.issueId ?? ctx.config?.taskId);
  const taskTitle = cfgString((ctx as any).context?.taskTitle ?? ctx.config?.taskTitle) || "";
  const taskBody = cfgString((ctx as any).context?.taskBody ?? ctx.config?.taskBody) || "";
  const commentId = cfgString((ctx as any).context?.commentId ?? ctx.config?.commentId) || "";
  const wakeReason = cfgString((ctx as any).context?.wakeReason ?? ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString((ctx as any).context?.companyName ?? ctx.config?.companyName) || "";
  const projectName = cfgString((ctx as any).context?.projectName ?? ctx.config?.projectName) || "";

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
const TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

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
      if (/^\[done\]\s*\u2502/.test(t)) return false;
      if (/^\u2502\s*[\p{Emoji_Presentation}]/u.test(t) && !/^\u2502\s*\U0001f4ac/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*\u2502\s*\U0001f4ac\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n")
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
// Per-tier execution
// ---------------------------------------------------------------------------

interface TierExecutionOptions {
  tier: FallbackTier;
  prompt: string;
  config: Record<string, unknown>;
  hermesCmd: string;
  timeoutSec: number;
  graceSec: number;
  maxTurns?: number;
  toolsets?: string;
  extraArgs?: string[];
  persistSession: boolean;
  worktreeMode: boolean;
  checkpoints: boolean;
  verbose?: boolean;
  prevSessionId?: string;
  cwd: string;
  baseEnv: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

interface TierResult {
  tier: FallbackTier;
  executionResult: AdapterExecutionResult;
  fallbackReason?: string;
}

async function executeWithTier(opts: TierExecutionOptions): Promise<TierResult> {
  const { tier, prompt, config, hermesCmd, timeoutSec, graceSec, maxTurns, toolsets, extraArgs, persistSession, worktreeMode, checkpoints, verbose, prevSessionId, cwd, baseEnv, onLog } = opts;

  // Build tier-specific environment
  const env: Record<string, string> = { ...baseEnv };

  // Tier 2: swap MINIMAX_API_KEY to PAYG key
  if (tier.minimaxApiKeyOverride) {
    env["MINIMAX_API_KEY"] = tier.minimaxApiKeyOverride;
  }

  // Tier 3: ensure OPENROUTER_API_KEY is set (for Kimi K2.5 via OpenRouter)
  // Tier 2: ensure MINIMAX_PAYG_KEY is available in env (used by provider)
  if (tier.tier === 2 && process.env["MINIMAX_PAYG_KEY"]) {
    env["MINIMAX_PAYG_KEY"] = process.env["MINIMAX_PAYG_KEY"];
  }
  if (tier.tier === 3 && process.env["OPENROUTER_API_KEY"]) {
    env["OPENROUTER_API_KEY"] = process.env["OPENROUTER_API_KEY"];
  }

  // Build command args
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  // Use tier's model
  args.push("-m", tier.model);

  // Provider: use tier's provider (not "auto" — explicit for fallback tiers)
  args.push("--provider", tier.provider);

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (verbose) args.push("-v");

  // Tag sessions as "tool" source
  args.push("--source", "tool");

  // Bypass dangerous-command approval prompts
  args.push("--yolo");

  // Session resume
  if (persistSession && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // Log tier start
  await onLog("stdout", `[hermes] [Tier ${tier.tier}/${FALLBACK_TIERS.length}] ${tier.label} — model=${tier.model}, provider=${tier.provider}\n`);

  // Execute
  const result = await runChildProcess("", hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: async (stream, chunk) => {
      // Reclassify benign stderr lines as stdout before passing to onLog
      if (stream === "stderr") {
        const trimmed = chunk.trimEnd();
        const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) ||
          /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) ||
          /Successfully registered all tools/.test(trimmed) ||
          /MCP [Ss]erver/.test(trimmed) ||
          /tool registered successfully/.test(trimmed) ||
          /Application initialized/.test(trimmed);
        if (isBenign) {
          await onLog("stdout", chunk);
          return;
        }
      }
      await onLog(stream, chunk);
    },
  });

  // Parse output
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
  const combinedOutput = (result.stdout || "") + "\n" + (result.stderr || "");

  await onLog("stdout", `[hermes] [Tier ${tier.tier}] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`);

  // Build execution result
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: tier.provider,
    model: tier.model,
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

  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
    tier: tier.tier,
    tier_label: tier.label,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  // Determine if this tier should fallback
  let fallbackReason: string | undefined;
  if (shouldFallback(tier, combinedOutput)) {
    fallbackReason = "rate-limit or 5xx detected";
  } else if (result.exitCode !== null && result.exitCode !== 0 && !parsed.response) {
    // Non-zero exit with no response = hard failure
    fallbackReason = `non-zero exit code ${result.exitCode} with no response`;
  }

  return { tier, executionResult, fallbackReason };
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

/**
 * Apply per-tier budget overrides from the adapter config.
 * Falls back to the DEFAULT constants.
 */
interface FallbackTierOverride {
  /** Tier 1, 2, or 3 */
  tier: number;
  /** Override daily budget (null = no limit, undefined = use default) */
  dailyBudgetUsd?: number | null;
}

function resolveFallbackTiers(
  config: Record<string, unknown>,
  defaultTiers: FallbackTier[],
): FallbackTier[] {
  const overrides = ((config.fallbackTiers as FallbackTierOverride[]) ?? [])
    .reduce<Record<number, FallbackTierOverride>>((acc, o) => {
      acc[o.tier] = o;
      return acc;
    }, {});

  return defaultTiers.map((tier) => {
    const override = overrides[tier.tier];
    if (override === undefined) return tier;
    return {
      ...tier,
      dailySpendLimitUsd:
        override.dailyBudgetUsd === undefined
          ? tier.dailySpendLimitUsd
          : override.dailyBudgetUsd,
    };
  });
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const verbose = cfgBoolean(config.verbose) === true;

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config);

  // ── Build base environment ─────────────────────────────────────────────
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) baseEnv.PAPERCLIP_RUN_ID = ctx.runId;
  if ((ctx as any).authToken && !baseEnv.PAPERCLIP_API_KEY)
    baseEnv.PAPERCLIP_API_KEY = (ctx as any).authToken as string;
  const taskId = cfgString((ctx as any).context?.taskId ?? (ctx as any).context?.issueId ?? ctx.config?.taskId);
  if (taskId) baseEnv.PAPERCLIP_TASK_ID = taskId;

  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(baseEnv, userEnv);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd = cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Wrapped onLog helper ───────────────────────────────────────────────
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    await ctx.onLog(stream, chunk);
  };

  // ── Session resume ID ─────────────────────────────────────────────────
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  if (prevSessionId) {
    await ctx.onLog("stdout", `[hermes] Resuming session: ${prevSessionId}\n`);
  }

  // ── Select initial tier ───────────────────────────────────────────────
  const spendTracker = new SpendTracker();
  const activeTiers = resolveFallbackTiers(config, FALLBACK_TIERS);
  let currentTier = selectInitialTier(spendTracker, activeTiers);

  if (!currentTier) {
    // All tiers over budget
    await ctx.onLog("stderr", "[hermes] ERROR: All fallback tiers over daily spend limit. Cannot execute.\n");
    return {
      exitCode: 1,
      errorMessage: "All fallback tiers over daily spend limit",
      summary: "No tier available: daily budgets exhausted",
      model: "unknown",
      provider: "unknown",
      signal: null,
      timedOut: false,
    };
  }

  // ── Tier loop ─────────────────────────────────────────────────────────
  let lastResult: TierResult | null = null;

  for (let attempt = 0; attempt < activeTiers.length; attempt++) {
    const tier = currentTier;
    if (!tier) break; // no more tiers available

    const result = await executeWithTier({
      tier,
      prompt,
      config,
      hermesCmd,
      timeoutSec,
      graceSec,
      maxTurns,
      toolsets,
      extraArgs,
      persistSession,
      worktreeMode,
      checkpoints,
      verbose,
      prevSessionId,
      cwd,
      baseEnv,
      onLog: wrappedOnLog,
    });

    lastResult = result;

    // Record spend (costUsd may be number | null from AdapterExecutionResult)
    if (result.executionResult.costUsd != null && typeof result.executionResult.costUsd === "number") {
      spendTracker.recordSpend(tier, result.executionResult.costUsd);
    }

    // Check if we should fallback
    if (result.fallbackReason) {
      await ctx.onLog("stdout", `[hermes] [Tier ${tier.tier}] FALLBACK triggered: ${result.fallbackReason}. Trying next tier.\n`);

      // Move to next tier
      const currentTierIndex = FALLBACK_TIERS.findIndex(t => t.tier === tier.tier);
      currentTier = FALLBACK_TIERS[currentTierIndex + 1] ?? null;

      // Skip tiers that are over budget
      while (currentTier && spendTracker.getRemainingBudget(currentTier) === 0) {
        await ctx.onLog("stdout", `[hermes] [Tier ${currentTier.tier}] Skipping — daily budget exhausted.\n`);
        const idx = FALLBACK_TIERS.findIndex(t => t.tier === currentTier!.tier);
        currentTier = FALLBACK_TIERS[idx + 1] ?? null;
      }

      if (!currentTier) {
        // No tier left — return tier-3 error
        await ctx.onLog("stderr", `[hermes] FATAL: All ${FALLBACK_TIERS.length} tiers exhausted.\n`);
        return {
          ...result.executionResult,
          errorMessage: [
            result.executionResult.errorMessage,
            `All fallback tiers exhausted (1->2->3). Last tier (${tier.tier}): ${result.fallbackReason}`,
          ].filter(Boolean).join("; ") || "All fallback tiers exhausted",
          summary: result.executionResult.summary,
        };
      }

      // Continue to next tier
      continue;
    }

    // Tier succeeded — return its result
    return result.executionResult;
  }

  // Should not reach here, but defensive
  if (lastResult) {
    return {
      ...lastResult.executionResult,
      errorMessage: [
        lastResult.executionResult.errorMessage,
        "Unexpected: fell through tier loop",
      ].filter(Boolean).join("; ") || "Unexpected fallback loop exit",
    };
  }

  return {
    exitCode: 1,
    errorMessage: "Fallback loop: no result returned",
    summary: "Fallback loop produced no result",
    model: "unknown",
    provider: "unknown",
    signal: null,
    timedOut: false,
  };
}
