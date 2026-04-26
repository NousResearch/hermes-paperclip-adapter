/**
 * Hermes Agent adapter for Paperclip.
 *
 * Runs Hermes Agent (https://github.com/NousResearch/hermes-agent)
 * as a managed employee in a Paperclip company. Hermes Agent is a
 * full-featured AI agent with 30+ native tools, persistent memory,
 * skills, session persistence, and MCP support.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Models available through Hermes Agent.
 *
 * Hermes supports any model via any provider. The Paperclip UI should
 * prefer detectModel() plus manual entry over curated placeholder models,
 * since Hermes availability depends on the user's local configuration.
 */
export const models: { id: string; label: string }[] = [];

type ConfigRecord = Record<string, unknown>;

/**
 * Probe an OpenAI-compatible /v1/models endpoint and return sorted model entries.
 * Returns an empty array on any error so callers can fall back gracefully.
 */
async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; label: string }[]> {
  try {
    const url = baseUrl.replace(/\/$/, "") + "/models";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: unknown[] };
    const items = Array.isArray(data?.data) ? data.data : [];
    return (items as { id?: string }[])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id as string, label: m.id as string }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function asRecord(value: unknown): ConfigRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ConfigRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function parseHermesConfig(content: string): ConfigRecord | null {
  try {
    return asRecord(parseYaml(content));
  } catch {
    return null;
  }
}

function resolveKey(rawKey: unknown): string {
  return asString(rawKey) ?? "";
}

function resolveKeyEnv(rawEnvName: unknown): string {
  const envName = asString(rawEnvName);
  return envName ? (process.env[envName] ?? "") : "";
}

function normalizeEndpoint(rawUrl: unknown): string | undefined {
  const url = asString(rawUrl)?.replace(/\/+$/, "");
  return url || undefined;
}

function addEndpoint(endpoints: Map<string, string>, rawUrl: unknown, key: string): void {
  const url = normalizeEndpoint(rawUrl);
  if (!url) return;
  if (!endpoints.has(url) || (!endpoints.get(url) && key)) endpoints.set(url, key);
}

function addConfiguredModel(modelsById: Map<string, string>, model: unknown): void {
  const id = asString(model);
  if (!id) return;
  if (!modelsById.has(id)) modelsById.set(id, id);
}

function extractConfiguredModels(config: ConfigRecord): Map<string, string> {
  const modelsById = new Map<string, string>();

  const modelConfig = asRecord(config.model);
  addConfiguredModel(modelsById, modelConfig?.default);

  const customProviders = Array.isArray(config.custom_providers) ? config.custom_providers : [];
  for (const entry of customProviders) {
    const provider = asRecord(entry);
    if (!provider) continue;
    addConfiguredModel(modelsById, provider.model);

    const configuredModels = asRecord(provider.models);
    if (!configuredModels) continue;
    for (const modelId of Object.keys(configuredModels)) addConfiguredModel(modelsById, modelId);
  }

  const providers = asRecord(config.providers);
  if (providers) {
    for (const entry of Object.values(providers)) {
      const provider = asRecord(entry);
      if (provider) addConfiguredModel(modelsById, provider.default_model);
    }
  }

  return modelsById;
}

function collectEndpoints(config: ConfigRecord): Map<string, string> {
  const endpoints = new Map<string, string>(); // url -> api_key

  const customProviders = Array.isArray(config.custom_providers) ? config.custom_providers : [];
  for (const entry of customProviders) {
    const provider = asRecord(entry);
    if (!provider) continue;
    const key = resolveKey(provider.api_key) || resolveKeyEnv(provider.key_env);
    addEndpoint(endpoints, provider.base_url ?? provider.url, key);
  }

  const providers = asRecord(config.providers);
  if (providers) {
    for (const entry of Object.values(providers)) {
      const provider = asRecord(entry);
      if (!provider) continue;
      const key = resolveKey(provider.api_key) || resolveKeyEnv(provider.key_env);
      addEndpoint(endpoints, provider.api, key);
    }
  }

  return endpoints;
}

/**
 * List all models available from the user's Hermes config.
 *
 * Reads `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml`), extracts
 * configured model ids plus unique `base_url` + credential pairs from the
 * `custom_providers` list and `providers` map, probes each endpoint's
 * `/v1/models` in parallel, and returns the deduplicated, sorted result.
 *
 * Falls back gracefully to configured model ids if the config uses `key_env`
 * credentials that are not available to the Paperclip process or an endpoint is
 * unreachable.
 */
export async function listModels(): Promise<{ id: string; label: string }[]> {
  const hermesHome = process.env["HERMES_HOME"]?.trim() || join(homedir(), ".hermes");
  const configPath = join(hermesHome, "config.yaml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }

  const config = parseHermesConfig(content);
  if (!config) return [];

  const modelsById = extractConfiguredModels(config);
  const endpoints = collectEndpoints(config);

  const fetched = await Promise.all(
    [...endpoints.entries()].map(([url, key]) => fetchOpenAIModels(url, key)),
  );

  for (const batch of fetched) {
    for (const m of batch) {
      if (!modelsById.has(m.id)) modelsById.set(m.id, m.label);
    }
  }
  return [...modelsById.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Documentation shown in the Paperclip UI when configuring a Hermes agent.
 */
export const agentConfigurationDoc = `# Hermes Agent Configuration

Hermes Agent is a full-featured AI agent by Nous Research with 30+ native
tools, persistent memory, session persistence, skills, and MCP support.

## Prerequisites

- Python 3.10+ installed
- Hermes Agent installed: \`pip install hermes-agent\`
- At least one LLM API key configured in ~/.hermes/.env

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | (Hermes configured default) | Optional explicit model in provider/model format. Leave blank to use Hermes's configured default model. |
| provider | string | (auto) | API provider: auto, openrouter, nous, openai-codex, zai, kimi-coding, minimax, minimax-cn. Usually not needed — Hermes auto-detects from model name. |
| timeoutSec | number | 300 | Execution timeout in seconds |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL |

## Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| toolsets | string | (all) | Comma-separated toolsets to enable (e.g. "terminal,file,web") |

## Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| persistSession | boolean | true | Resume sessions across heartbeats |
| worktreeMode | boolean | false | Use git worktree for isolated changes |
| checkpoints | boolean | false | Enable filesystem checkpoints |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| hermesCommand | string | hermes | Path to hermes CLI binary |
| verbose | boolean | false | Enable verbose output |
| extraArgs | string[] | [] | Additional CLI arguments |
| env | object | {} | Extra environment variables |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{projectName}}\` — Project name (if scoped to a project)
`;
