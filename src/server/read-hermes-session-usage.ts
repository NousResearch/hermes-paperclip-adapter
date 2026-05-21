/**
 * Read per-session token usage and cost from Hermes' SQLite session store.
 *
 * Hermes records the following columns on its `sessions` table for every
 * conversation it runs (state.db at $HERMES_HOME/state.db):
 *
 *   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
 *   reasoning_tokens, billing_provider, billing_base_url, billing_mode,
 *   estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
 *   pricing_version
 *
 * The numbers come from the provider SDK responses (Anthropic / OpenAI /
 * etc.) — they're the real, authoritative usage figures. They surface to
 * the user via `hermes insights` and `hermes sessions export`.
 *
 * The adapter's existing stdout regexes (`TOKEN_USAGE_REGEX`, `COST_REGEX`)
 * only match if Hermes prints a `tokens: N input M output` / `cost: $X`
 * line — which it does NOT under the default Anthropic provider path.
 * Result: `cost_events` in Paperclip stays empty and the Costs UI shows
 * zero spend even for active agents.
 *
 * Rather than shipping a sqlite native dep or polling Hermes' DB directly,
 * this module shells out to Hermes' own `sessions export --session-id <id> -`
 * which emits the session row as the first line of JSONL on stdout.
 * Zero new deps, no engines bump.
 *
 * Returns null on any error (binary missing, session not found, malformed
 * JSON, older Hermes versions without the export command) so callers can
 * fall back to other sources without breaking the run.
 */

import { spawn } from "node:child_process";
import type { UsageSummary } from "@paperclipai/adapter-utils";

import { HERMES_CLI } from "../shared/constants.js";

export interface HermesSessionUsage {
  usage: UsageSummary;
  costUsd?: number;
  billingProvider?: string;
}

export interface ReadHermesSessionUsageOptions {
  /** Hermes CLI binary (default: HERMES_CLI). */
  hermesCmd?: string;
  /** Hermes home directory — drives which state.db gets read. */
  hermesHome?: string;
  /** Session UUID/timestamp id from a completed run. */
  sessionId: string;
  /** Hard timeout for the export process. */
  timeoutMs?: number;
}

/**
 * Spawn `hermes sessions export --session-id <id> -` and parse the first
 * JSONL line for token usage and cost.
 */
export async function readHermesSessionUsage(
  opts: ReadHermesSessionUsageOptions,
): Promise<HermesSessionUsage | null> {
  const {
    hermesCmd = HERMES_CLI,
    hermesHome,
    sessionId,
    timeoutMs = 5000,
  } = opts;
  if (!sessionId) return null;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (hermesHome) env.HERMES_HOME = hermesHome;

  return new Promise<HermesSessionUsage | null>((resolve) => {
    let settled = false;
    const done = (v: HermesSessionUsage | null) => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch { /* already exited */ }
      resolve(v);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(
        hermesCmd,
        ["sessions", "export", "--session-id", sessionId, "-"],
        { env, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      done(null);
    }, timeoutMs);
    timer.unref?.();

    let buf = "";
    let consumed = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (consumed) return;
      buf += chunk.toString("utf8");
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx === -1) return;
      consumed = true;
      clearTimeout(timer);

      const firstLine = buf.slice(0, newlineIdx).trim();
      done(parseSessionRow(firstLine));
    });

    proc.on("error", () => {
      clearTimeout(timer);
      done(null);
    });

    proc.on("close", () => {
      clearTimeout(timer);
      if (!consumed) {
        // No newline ever arrived. Try to parse whatever buffered (rare).
        const trimmed = buf.trim();
        done(trimmed ? parseSessionRow(trimmed) : null);
      }
    });
  });
}

function parseSessionRow(line: string): HermesSessionUsage | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const inputTokens = numberOrZero(r.input_tokens);
  const outputTokens = numberOrZero(r.output_tokens);
  const cachedInputTokens = numberOrZero(r.cache_read_tokens);
  const hasAnyTokens =
    inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  if (!hasAnyTokens) return null;

  const usage: UsageSummary = { inputTokens, outputTokens };
  if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens;

  // Prefer the provider-confirmed actual cost; fall back to Hermes' estimate.
  const costUsd =
    numberOrUndefined(r.actual_cost_usd) ??
    numberOrUndefined(r.estimated_cost_usd);

  const billingProvider = stringOrUndefined(r.billing_provider);

  const result: HermesSessionUsage = { usage };
  if (costUsd !== undefined) result.costUsd = costUsd;
  if (billingProvider) result.billingProvider = billingProvider;
  return result;
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
