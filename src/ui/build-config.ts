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
} from "../shared/constants.js";

/**
 * Parse KEY=VALUE lines from a multiline string.
 * Skips blank lines and lines starting with #.
 */
export function parseEnvVars(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Parse env bindings that may carry {type:"plain",value} or
 * {type:"secret_ref",secretId,version?} shapes.
 */
export function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(
    bindings as Record<string, unknown>,
  )) {
    if (typeof binding === "string") {
      result[key] = { type: "plain" as const, value: binding };
      continue;
    }
    if (!binding || typeof binding !== "object") continue;
    const b = binding as Record<string, unknown>;
    if (b["type"] === "plain") {
      result[key] = b["value"];
    } else if (b["type"] === "secret_ref") {
      result[key] = {
        secretId: b["secretId"],
        ...(b["version"] !== undefined ? { version: b["version"] } : {}),
      };
    }
  }
  return result;
}

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

  // NOTE: Provider is NOT set here because the Paperclip UI form
  // (CreateConfigValues) does not expose a provider field.
  // Instead, provider is resolved at runtime in execute.ts using
  // a priority chain:
  //   1. adapterConfig.provider (if set via API directly)
  //   2. ~/.hermes/config.yaml detection
  //   3. Model-name prefix inference
  //   4. "auto" fallback
  // This ensures correct provider routing even for agents created
  // before provider tracking existed.

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
    ac.extraArgs = v.extraArgs.split(",").map((s) => s.trim()).filter(Boolean);
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

  // Instructions file path
  if (v.instructionsFilePath) {
    ac.instructionsFilePath = v.instructionsFilePath;
  }

  // Bootstrap prompt
  if (v.bootstrapPrompt) {
    ac.bootstrapPromptTemplate = v.bootstrapPrompt;
  }

  // Environment variables — bindings take priority over plain text vars
  const envFromBindings = parseEnvBindings(v.envBindings);
  const envFromVars = parseEnvVars(v.envVars ?? "");
  const mergedEnv: Record<string, unknown> = {
    ...envFromVars,
    ...envFromBindings,
  };
  if (Object.keys(mergedEnv).length > 0) {
    ac.env = mergedEnv;
  }

  // Provider override (from adapter-specific schema values).
  // adapterSchemaValues is not yet part of the published CreateConfigValues
  // type but may be present at runtime when the Paperclip host is newer.
  const schemaValues = (v as unknown as Record<string, unknown>)[
    "adapterSchemaValues"
  ] as Record<string, unknown> | undefined;
  const provider = schemaValues?.["provider"];
  if (typeof provider === "string" && provider.trim()) {
    ac.provider = provider.trim();
  }

  // Toolsets (from adapter-specific schema values)
  const toolsets = schemaValues?.["toolsets"];
  if (typeof toolsets === "string" && toolsets.trim()) {
    ac.toolsets = toolsets.trim();
  }

  // Profile (from adapter-specific schema values)
  // Persist profile name and inject -p flag so Hermes runs the right profile.
  const profile = schemaValues?.["profile"];
  if (typeof profile === "string" && profile.trim()) {
    ac.profile = profile.trim();
    const existing = (ac.extraArgs as string[]) || [];
    if (!existing.includes("-p") && !existing.includes("--profile")) {
      existing.push("-p", profile.trim());
      ac.extraArgs = existing;
    }
  }

  // Heartbeat config is handled by Paperclip itself

  return ac;
}
