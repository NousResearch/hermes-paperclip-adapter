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

function parseYamlScalar(raw: string | undefined): string | undefined {
  let value = raw?.trim();
  if (!value) return undefined;

  const quoted = value.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2];

  value = value.replace(/\s+#.*$/, "").trim();
  return value || undefined;
}

function extractIndentedSection(content: string, sectionName: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^${sectionName}:\\s*(?:#.*)?$`).test(line),
  );
  if (start === -1) return "";

  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0 && trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

function readScalar(block: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return parseYamlScalar(block.match(new RegExp(`^\\s+${escaped}:\\s*(.*)$`, "m"))?.[1]);
}

function resolveKey(rawKey: string | undefined): string {
  const inlineKey = parseYamlScalar(rawKey);
  return inlineKey ?? "";
}

function resolveKeyEnv(rawEnvName: string | undefined): string {
  const envName = parseYamlScalar(rawEnvName);
  return envName ? (process.env[envName] ?? "") : "";
}

function normalizeEndpoint(rawUrl: string | undefined): string | undefined {
  const url = parseYamlScalar(rawUrl)?.replace(/\/+$/, "");
  return url || undefined;
}

function addEndpoint(endpoints: Map<string, string>, rawUrl: string | undefined, key: string): void {
  const url = normalizeEndpoint(rawUrl);
  if (!url) return;
  if (!endpoints.has(url) || (!endpoints.get(url) && key)) endpoints.set(url, key);
}

function addConfiguredModel(modelsById: Map<string, string>, model: string | undefined): void {
  const id = parseYamlScalar(model);
  if (!id) return;
  if (!modelsById.has(id)) modelsById.set(id, id);
}

function extractCustomProviderModelKeys(block: string): string[] {
  const lines = block.split("\n");
  let modelsIndent: number | null = null;
  let modelKeyIndent: number | null = null;
  const modelKeys: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    if (modelsIndent === null) {
      if (/^models:\s*(?:#.*)?$/.test(trimmed)) modelsIndent = indent;
      continue;
    }

    if (indent <= modelsIndent) break;

    const match = line.match(/^\s*([^:#][^:]*):\s*(?:#.*)?$/);
    if (!match) continue;
    if (modelKeyIndent === null) modelKeyIndent = indent;
    if (indent !== modelKeyIndent) continue;

    const key = parseYamlScalar(match[1]);
    if (key) modelKeys.push(key);
  }

  return modelKeys;
}

function extractConfiguredModels(content: string): Map<string, string> {
  const modelsById = new Map<string, string>();

  const modelSection = extractIndentedSection(content, "model");
  addConfiguredModel(modelsById, readScalar(modelSection, "default"));

  const cpSection = extractIndentedSection(content, "custom_providers");
  for (const block of cpSection.split(/(?=^\s+-\s)/m).filter(Boolean)) {
    addConfiguredModel(modelsById, readScalar(block, "model"));
    for (const modelKey of extractCustomProviderModelKeys(block)) addConfiguredModel(modelsById, modelKey);
  }

  const provSection = extractIndentedSection(content, "providers");
  for (const block of provSection.split(/(?=^[ \t]{2}[^ \t:#][^:]*:\s*(?:#.*)?$)/m).filter(Boolean)) {
    addConfiguredModel(modelsById, readScalar(block, "default_model"));
  }

  return modelsById;
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

  const modelsById = extractConfiguredModels(content);

  // Extract unique (base_url, credential) pairs via lightweight regex parsing.
  // Covers both the `custom_providers:` list and the `providers:` map.
  const endpoints = new Map<string, string>(); // url -> api_key

  // custom_providers: list of {name, base_url, model, api_key?, key_env?}
  const cpSection = extractIndentedSection(content, "custom_providers");
  for (const block of cpSection.split(/(?=^\s+-\s)/m).filter(Boolean)) {
    const url = readScalar(block, "base_url") ?? readScalar(block, "url");
    const key = resolveKey(readScalar(block, "api_key")) || resolveKeyEnv(readScalar(block, "key_env"));
    addEndpoint(endpoints, url, key);
  }

  // providers: map of name -> {api, api_key?, key_env?, default_model}
  const provSection = extractIndentedSection(content, "providers");
  for (const block of provSection.split(/(?=^[ \t]{2}[^ \t:#][^:]*:\s*(?:#.*)?$)/m).filter(Boolean)) {
    const key = resolveKey(readScalar(block, "api_key")) || resolveKeyEnv(readScalar(block, "key_env"));
    addEndpoint(endpoints, readScalar(block, "api"), key);
  }

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
