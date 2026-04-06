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

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import { parseHermesOutput, isHermesUnknownSessionError, isHermesMaxTurnsResult } from "./parse.js";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureCommandResolvable,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  ensureAbsoluteDirectory,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
} from "../shared/constants.js";
import { resolveHermesHomeDir } from "../shared/profile.js";

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
// Prompt builder
// ---------------------------------------------------------------------------

// Match the default prompt template used by all other Paperclip adapters.
// The heartbeat workflow, curl examples, checkout procedure, and API reference
// are provided by the `paperclip` skill (injected at runtime via -s flag),
// NOT hardcoded into the adapter. This avoids divergence between adapters.
const DEFAULT_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  const templateData: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName: ctx.agent?.name || "Hermes Agent",
    companyId: ctx.agent?.companyId || "",
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    context: ctx.context || {},
  };

  return renderTemplate(template, templateData);
}

// ---------------------------------------------------------------------------
// Instructions file loading
// ---------------------------------------------------------------------------

/**
 * Read agent instructions from the managed AGENTS.md file and prepend
 * them to the prompt. This mirrors claude-local's --append-system-prompt-file
 * behavior but injects directly into the prompt since Hermes has no
 * equivalent CLI flag.
 */
async function loadInstructionsContent(
  config: Record<string, unknown>,
): Promise<string | null> {
  const filePath = cfgString(config.instructionsFilePath);
  if (!filePath) return null;

  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (!content.trim()) return null;
    const dir = path.dirname(filePath) + "/";
    return (
      content.trimEnd() +
      `\n\nThe above agent instructions were loaded from ${filePath}. ` +
      `Resolve any relative file references from ${dir}.`
    );
  } catch {
    // File not found or not readable — non-fatal
    return null;
  }
}

// ---------------------------------------------------------------------------
// Billing helper
// ---------------------------------------------------------------------------

function hasNonEmptyEnvValue(env: Record<string, unknown>, key: string): boolean {
  const val = env[key];
  return typeof val === "string" && val.length > 0;
}

/**
 * Resolve billing info based on the provider and available API keys.
 *
 * - Anthropic without ANTHROPIC_API_KEY → subscription (Claude Pro/Team login)
 * - Copilot/Copilot-ACP without OPENAI_API_KEY → subscription
 * - All other providers → api (direct API billing)
 *
 * Mirrors the pattern used by claude-local and codex-local adapters.
 */
export function resolveHermesBilling(
  provider: string,
  env: Record<string, unknown>,
): { biller: string; billingType: "api" | "subscription" } {
  const billerMap: Record<string, string> = {
    anthropic: "anthropic",
    openrouter: "openrouter",
    "openai-codex": "openai",
    copilot: "openai",
    "copilot-acp": "openai",
    nous: "nous",
    zai: "zai",
    "kimi-coding": "kimi",
    minimax: "minimax",
    "minimax-cn": "minimax",
    huggingface: "huggingface",
  };

  const biller = billerMap[provider] || provider || "unknown";

  // Detect subscription mode for providers that support it
  if (provider === "anthropic" && !hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY")) {
    return { biller, billingType: "subscription" };
  }
  if (
    (provider === "copilot" || provider === "copilot-acp") &&
    !hasNonEmptyEnvValue(env, "OPENAI_API_KEY")
  ) {
    return { biller, billingType: "subscription" };
  }

  return { biller, billingType: "api" };
}

// ---------------------------------------------------------------------------
// Cost/usage from Hermes state.db
// ---------------------------------------------------------------------------

interface SessionDbData {
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Read cost and token usage from Hermes's SQLite database.
 *
 * Hermes stores `estimated_cost_usd`, `input_tokens`, and `output_tokens`
 * in the `sessions` table of `state.db`. This is the source of truth for
 * cost — stdout regex is unreliable in quiet mode.
 *
 * Requires Node.js 22+ (node:sqlite). Non-fatal on failure.
 */
export async function getSessionDataFromDb(
  sessionId: string,
  dbPath: string,
): Promise<SessionDbData | null> {
  try {
    // Dynamic import to avoid hard failure on Node < 22
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { open: true });
    try {
      const stmt = db.prepare(
        "SELECT estimated_cost_usd, input_tokens, output_tokens FROM sessions WHERE id = ?",
      );
      const row = stmt.get(sessionId) as {
        estimated_cost_usd: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
      } | undefined;
      if (!row || row.estimated_cost_usd == null) return null;
      return {
        costUsd: row.estimated_cost_usd,
        inputTokens: row.input_tokens ?? null,
        outputTokens: row.output_tokens ?? null,
      };
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal: database missing, table missing, Node < 22, etc.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const context = (ctx.context ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd =
    cfgString(config.hermesCommand) ||
    cfgString(config.command) || // UI writes "command", not "hermesCommand"
    HERMES_CLI;
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Resolve provider (defense in depth) ────────────────────────────────
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel(undefined, config);
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
  // Compose the prompt from multiple sections, similar to claude-local:
  //   1. Agent instructions (AGENTS.md from Instructions tab)
  //   2. Wake prompt (structured Paperclip wake payload, if available)
  //   3. Heartbeat prompt (the main template with task/comment/heartbeat sections)

  // Hoist prevSessionId so it's available for both prompt building and args
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  const instructionsContent = await loadInstructionsContent(config);

  // Use Paperclip's structured wake prompt renderer if a wake payload exists
  // and the function is available in this version of adapter-utils
  let wakePrompt: string | null = null;
  if (context.paperclipWake) {
    try {
      wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
        resumedSession: Boolean(prevSessionId),
      });
    } catch {
      // Non-fatal — fall back to template-only prompt
    }
  }

  // Session handoff markdown (set by server when rotating sessions)
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown);

  const heartbeatPrompt = buildPrompt(ctx, config);

  let bootstrapPrompt: string | null = null;
  const bootstrapTemplate = cfgString(config.bootstrapPromptTemplate);
  if (bootstrapTemplate && !(persistSession && prevSessionId)) {
    const templateData: Record<string, unknown> = {
      agentId: ctx.agent?.id || "",
      agentName: ctx.agent?.name || "Hermes Agent",
      companyId: ctx.agent?.companyId || "",
      runId: ctx.runId || "",
      agent: ctx.agent || {},
      context: ctx.context || {},
    };
    bootstrapPrompt = renderTemplate(bootstrapTemplate, templateData);
  }

  const prompt = joinPromptSections([
    instructionsContent,
    bootstrapPrompt,
    wakePrompt,
    sessionHandoffMarkdown,
    heartbeatPrompt,
  ]);

  // Track prompt section sizes for observability (matches claude-local/codex-local)
  const promptMetrics: Record<string, number> = {
    promptChars: prompt.length,
    heartbeatPromptChars: heartbeatPrompt.length,
  };
  if (instructionsContent) promptMetrics.instructionsChars = instructionsContent.length;
  if (bootstrapPrompt) promptMetrics.bootstrapPromptChars = bootstrapPrompt.length;
  if (wakePrompt) promptMetrics.wakePromptChars = wakePrompt.length;
  if (sessionHandoffMarkdown) promptMetrics.sessionHandoffChars = sessionHandoffMarkdown.length;

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
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
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY.
  args.push("--yolo");

  // Session resume — read params now, validate CWD after cwd is resolved below
  // (prevSessionId was hoisted above for use in prompt building)
  const prevSessionCwd = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.cwd,
  );

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Inject Paperclip skills ────────────────────────────────────────────
  // The Paperclip server populates config.paperclipRuntimeSkills with
  // materialized skill entries (source paths on disk). We create real
  // directories inside ~/.hermes/skills/paperclip/<name>/ and symlink
  // the individual files (SKILL.md, references/, etc.) into them.
  //
  // Why not symlink the directory itself? Python's pathlib.rglob() does
  // not follow directory symlinks, so Hermes's skill scanner would miss
  // them entirely. By creating a real directory with symlinked contents,
  // rglob traverses into it and finds SKILL.md.
  //
  // Then pass each skill name via the -s flag so Hermes preloads them
  // into the agent's system prompt for the session.
  const runtimeSkills = config.paperclipRuntimeSkills;
  if (Array.isArray(runtimeSkills) && runtimeSkills.length > 0) {
    try {
      const hermesHome = resolveHermesHomeDir(config);
      const paperclipSkillsDir = path.join(hermesHome, "skills", "paperclip");
      await fs.mkdir(paperclipSkillsDir, { recursive: true });
      const injectedSkillNames: string[] = [];

      for (const entry of runtimeSkills) {
        const e = entry as Record<string, unknown>;
        const name = cfgString(e.runtimeName) || cfgString(e.key);
        const source = cfgString(e.source);
        if (!name || !source) continue;

        const targetDir = path.join(paperclipSkillsDir, name);
        try {
          // Create a real directory (not a symlink) so rglob traverses it
          await fs.mkdir(targetDir, { recursive: true });

          // Symlink each file/subdir from the source into the target dir
          const sourceEntries = await fs.readdir(source, { withFileTypes: true });
          for (const srcEntry of sourceEntries) {
            const srcPath = path.join(source, srcEntry.name);
            const dstPath = path.join(targetDir, srcEntry.name);

            // Check if symlink already correct
            const existingTarget = await fs.readlink(dstPath).catch(() => null);
            if (existingTarget === srcPath) continue;

            // Remove stale entry
            if (existingTarget !== null || await fs.stat(dstPath).catch(() => null)) {
              await fs.rm(dstPath, { recursive: true, force: true });
            }

            await fs.symlink(srcPath, dstPath);
          }

          injectedSkillNames.push(name);
        } catch {
          // Non-fatal — skip this skill
        }
      }

      if (injectedSkillNames.length > 0) {
        // Use category/name format since skills are in paperclip/ subdir
        args.push("-s", injectedSkillNames.map((n) => `paperclip/${n}`).join(","));
      }
    } catch {
      // Non-fatal — skills injection failed, agent runs without Paperclip skills
    }
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // Read task/wake context from ctx.context (wake context)
  const envTaskId =
    cfgString(context.taskId) ||
    cfgString(context.issueId) ||
    cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;

  const envWakeReason =
    cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;

  const envCommentId =
    cfgString(context.commentId) ||
    cfgString(context.wakeCommentId) ||
    cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  const approvalId = cfgString(context.approvalId);
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = cfgString(context.approvalStatus);
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  // Workspace context — pass through so agent scripts can use them
  const workspace = context.paperclipWorkspace as Record<string, unknown> | undefined;
  if (workspace) {
    if (cfgString(workspace.cwd)) env.PAPERCLIP_WORKSPACE_CWD = workspace.cwd as string;
    if (cfgString(workspace.source)) env.PAPERCLIP_WORKSPACE_SOURCE = workspace.source as string;
    if (cfgString(workspace.strategy)) env.PAPERCLIP_WORKSPACE_STRATEGY = workspace.strategy as string;
    if (cfgString(workspace.workspaceId)) env.PAPERCLIP_WORKSPACE_ID = workspace.workspaceId as string;
    if (cfgString(workspace.repoUrl)) env.PAPERCLIP_WORKSPACE_REPO_URL = workspace.repoUrl as string;
    if (cfgString(workspace.repoRef)) env.PAPERCLIP_WORKSPACE_REPO_REF = workspace.repoRef as string;
    if (cfgString(workspace.branchName)) env.PAPERCLIP_WORKSPACE_BRANCH = workspace.branchName as string;
    if (cfgString(workspace.worktreePath)) env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspace.worktreePath as string;
    if (cfgString(workspace.agentHome)) env.AGENT_HOME = workspace.agentHome as string;
  }

  // Linked issues
  const issueIds = context.issueIds;
  if (Array.isArray(issueIds) && issueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = issueIds.join(",");
  }

  // Wake payload JSON for agents that want structured context
  if (context.paperclipWake) {
    try {
      const payload = stringifyPaperclipWakePayload(context.paperclipWake);
      if (payload) env.PAPERCLIP_WAKE_PAYLOAD_JSON = payload;
    } catch {
      // Non-fatal
    }
  }

  // Runtime service env vars
  const workspaces = context.paperclipWorkspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    try { env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaces); } catch {}
  }
  const serviceIntents = context.paperclipRuntimeServiceIntents;
  if (Array.isArray(serviceIntents) && serviceIntents.length > 0) {
    try { env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(serviceIntents); } catch {}
  }
  const services = context.paperclipRuntimeServices;
  if (Array.isArray(services) && services.length > 0) {
    try { env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(services); } catch {}
  }
  const primaryUrl = cfgString(context.paperclipRuntimePrimaryUrl);
  if (primaryUrl) env.PAPERCLIP_RUNTIME_PRIMARY_URL = primaryUrl;

  // User-configured env vars (already resolved by the server — plain strings)
  const userEnv = config.env;
  if (userEnv && typeof userEnv === "object" && !Array.isArray(userEnv)) {
    for (const [key, val] of Object.entries(userEnv as Record<string, unknown>)) {
      if (typeof val === "string") {
        env[key] = val;
      } else if (val && typeof val === "object" && "value" in val && typeof (val as any).value === "string") {
        // Handle legacy wrapped format: { type: "plain", value: "..." }
        env[key] = (val as any).value;
      }
    }
  }

  // Inject authToken as PAPERCLIP_API_KEY so Hermes can authenticate
  // to the Paperclip API. ctx.authToken is a first-class field on
  // AdapterExecutionContext — no cast needed.
  // Only set if userEnv didn't already provide an explicit PAPERCLIP_API_KEY.
  const hasExplicitApiKey = typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY.length > 0;
  if (ctx.authToken && !hasExplicitApiKey) {
    env.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // ── Resolve working directory ──────────────────────────────────────────
  // Prefer workspace CWD from context (set by Paperclip's workspace
  // resolver), fall back to adapter config, then process cwd.
  let cwd: string;
  if (workspace && cfgString(workspace.cwd) && cfgString(workspace.source) !== "agent_home") {
    cwd = workspace.cwd as string;
  } else {
    cwd = cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  }
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  } catch {
    // Non-fatal
  }

  // ── Session resume (CWD-validated) ────────────────────────────────────
  let sessionId: string | null = (persistSession && prevSessionId) ? prevSessionId : null;
  if (sessionId && prevSessionCwd && prevSessionCwd !== cwd) {
    await ctx.onLog(
      "stdout",
      `[hermes] CWD mismatch: session was started in ${prevSessionCwd}, current cwd is ${cwd}. Dropping session resume.\n`,
    );
    sessionId = null;
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // ── Emit invocation metadata ───────────────────────────────────────────
  // Report execution metadata so Paperclip can display it in the run
  // detail view (command, args, env, prompt).
  if (ctx.onMeta) {
    try {
      const loggedEnv = buildInvocationEnvForLogs(env);
      await ctx.onMeta({
        adapterType: "hermes_local",
        command: hermesCmd,
        cwd,
        commandArgs: args,
        commandNotes: instructionsContent
          ? [`Injected agent instructions from ${cfgString(config.instructionsFilePath)}`]
          : undefined,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    } catch {
      // Non-fatal — metadata reporting should never block execution
    }
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (sessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${sessionId}\n`,
    );
  }
  if (instructionsContent) {
    await ctx.onLog(
      "stdout",
      `[hermes] Injected agent instructions from ${cfgString(config.instructionsFilePath)}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  //
  // For skill security warnings: Hermes hardcodes ~/.hermes/skills/ as the
  // trusted directory, but profile skills live in ~/.hermes/profiles/<name>/skills/.
  // We suppress warnings that reference our own injected skills path (known safe)
  // while letting warnings about unknown paths through.
  const hermesHome = resolveHermesHomeDir(config);
  const ownSkillsPath = path.join(hermesHome, "skills");
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Reclassify known-safe skill security warnings with [hermes] prefix
      if (/Skill security warning/.test(trimmed) && trimmed.includes(ownSkillsPath)) {
        return ctx.onLog("stdout", `[hermes] ${chunk}`);
      }
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) ||
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) ||
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

  // ── Validate command resolvability ────────────────────────────────────
  try {
    await ensureCommandResolvable(hermesCmd, cwd, env as NodeJS.ProcessEnv);
  } catch (err) {
    // Non-fatal — proceed with original command, let runChildProcess handle errors
    await ctx.onLog("stderr", `[hermes] Warning: could not verify "${hermesCmd}" is resolvable: ${(err as Error).message}\n`);
  }

  let clearSessionOnRetry = false;

  try {
    let result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    });

    // Retry on unknown session error (session ID no longer valid on Hermes side)
    if (
      sessionId &&
      result.exitCode !== 0 &&
      !result.timedOut &&
      isHermesUnknownSessionError(result.stdout || "", result.stderr || "")
    ) {
      await ctx.onLog(
        "stdout",
        `[hermes] Unknown session error detected; retrying without --resume.\n`,
      );
      const retryArgs = args.filter((arg, i, arr) =>
        !(arg === "--resume" || (i > 0 && arr[i - 1] === "--resume" && arg === sessionId)),
      );
      result = await runChildProcess(ctx.runId, hermesCmd, retryArgs, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
        onSpawn: ctx.onSpawn,
      });
      clearSessionOnRetry = true;
    }

    // ── Parse output ───────────────────────────────────────────────────────
    const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

    await ctx.onLog(
      "stdout",
      `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
    );
    if (parsed.sessionId) {
      await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
    }

    // ── Enrich cost/usage from state.db ──────────────────────────────────
    // Hermes quiet mode does not emit cost/usage to stdout. Query state.db
    // as the authoritative source, falling back to parsed stdout values.
    if (parsed.sessionId) {
      try {
        const hermesHome = resolveHermesHomeDir(config);
        const stateDbPath = path.join(hermesHome, "state.db");
        const dbData = await getSessionDataFromDb(parsed.sessionId, stateDbPath);
        if (dbData) {
          if (parsed.costUsd === undefined) {
            parsed.costUsd = dbData.costUsd;
            await ctx.onLog("stdout", `[hermes] Cost from state.db: $${dbData.costUsd.toFixed(6)}\n`);
          }
          if (!parsed.usage && (dbData.inputTokens != null || dbData.outputTokens != null)) {
            parsed.usage = {
              inputTokens: dbData.inputTokens ?? 0,
              outputTokens: dbData.outputTokens ?? 0,
            };
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // ── Build result ───────────────────────────────────────────────────────
    const executionResult: AdapterExecutionResult = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      provider: resolvedProvider,
      model,
    };

    const billing = resolveHermesBilling(resolvedProvider, env);
    executionResult.biller = billing.biller;
    executionResult.billingType = billing.billingType;

    if (result.timedOut) {
      executionResult.errorMessage = `Timed out after ${timeoutSec}s`;
      executionResult.errorCode = "timeout";
    } else if (parsed.errorMessage) {
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

    // Set resultJson so Paperclip can persist run metadata
    executionResult.resultJson = {
      result: parsed.response || "",
      session_id: parsed.sessionId || null,
      usage: parsed.usage || null,
      cost_usd: parsed.costUsd ?? null,
    };

    // Store session ID and workspace metadata for next run
    if (persistSession && parsed.sessionId) {
      const sessionParams: Record<string, string> = {
        sessionId: parsed.sessionId,
        cwd,
      };
      // Include workspace metadata for execution workspace lifecycle
      const wsId = workspace ? cfgString(workspace.workspaceId) : undefined;
      const wsRepoUrl = workspace ? cfgString(workspace.repoUrl) : undefined;
      const wsRepoRef = workspace ? cfgString(workspace.repoRef) : undefined;
      if (wsId) sessionParams.workspaceId = wsId;
      if (wsRepoUrl) sessionParams.repoUrl = wsRepoUrl;
      if (wsRepoRef) sessionParams.repoRef = wsRepoRef;

      executionResult.sessionParams = sessionParams;
      executionResult.sessionDisplayId = parsed.sessionId;
    }

    // Signal Paperclip to clear the persisted session when needed
    if (clearSessionOnRetry || isHermesMaxTurnsResult(result.stdout || "", result.stderr || "")) {
      executionResult.clearSession = true;
    }

    return executionResult;
  } finally {
    // Skills are persistently symlinked into ~/.hermes/skills/paperclip/
    // and reused across runs — no temp directory cleanup needed.
  }
}
