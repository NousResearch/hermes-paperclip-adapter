/**
 * Build adapter configuration from UI form values.
 *
 * Translates Paperclip's CreateConfigValues into the adapterConfig
 * object stored in the agent record.
 *
 * NOTE: Provider resolution happens at runtime in execute.ts, not here.
 * The UI may or may not pass a provider field. If it does, we persist it
 * as the user's explicit override. If not, execute.ts will detect it from
 * ~/.hermes/config.yaml at runtime.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import {
  DEFAULT_TIMEOUT_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";

/**
 * Build a Hermes Agent adapter config from the Paperclip UI form values.
 */
export function buildHermesConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // Model
  if (v.model.trim()) {
    ac.model = v.model.trim();
  }

  // Provider: persist if the Paperclip create-form passed one (e.g. for
  // subscription-backed providers like openai-codex). The base
  // CreateConfigValues type does not declare `provider`, but downstream
  // forms can extend it; we accept it via duck-typing.
  // If absent, runtime in execute.ts resolves via:
  //   1. ~/.hermes/config.yaml detection
  //   2. Model-name prefix inference
  //   3. "auto" fallback
  const providerCandidate = (v as { provider?: unknown }).provider;
  if (
    typeof providerCandidate === "string" &&
    (VALID_PROVIDERS as readonly string[]).includes(providerCandidate)
  ) {
    ac.provider = providerCandidate;
  }

  // Execution limits — let the user configure these from the Paperclip UI.
  // timeoutSec: wall-clock kill timeout for the hermes child process.
  // maxTurnsPerRun: maps to Hermes's --max-turns (agent tool-calling iterations).
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (v.maxTurnsPerRun > 0) {
    ac.maxTurnsPerRun = v.maxTurnsPerRun;
    // Scale timeout to match: ~20s per tool turn is generous headroom.
    // Never go below the default (1800s / 30 min).
    ac.timeoutSec = Math.max(DEFAULT_TIMEOUT_SEC, v.maxTurnsPerRun * 20);
  }

  // Session persistence (default: on)
  ac.persistSession = true;

  // Working directory
  if (v.cwd) {
    ac.cwd = v.cwd;
  }

  // Custom hermes binary path
  if (v.command) {
    ac.hermesCommand = v.command;
  }

  // Extra CLI arguments
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);
  }

  // Thinking/reasoning effort
  if (v.thinkingEffort) {
    const existing = (ac.extraArgs as string[]) || [];
    existing.push("--reasoning-effort", String(v.thinkingEffort));
    ac.extraArgs = existing;
  }

  // Prompt template
  if (v.promptTemplate) {
    ac.promptTemplate = v.promptTemplate;
  }

  // Heartbeat config is handled by Paperclip itself

  return ac;
}
