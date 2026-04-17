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

/**
 * List all models available from the user's Hermes config.
 *
 * Reads `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml`), extracts
 * unique `base_url` + `api_key` pairs from the `custom_providers` list and
 * `providers` map, probes each endpoint's `/v1/models` in parallel, and
 * returns the deduplicated, sorted result.
 *
 * Falls back gracefully to an empty list if the config is missing or any
 * endpoint is unreachable.
 */
export async function listModels(): Promise<{ id: string; label: string }[]> {
  const hermesHome = process.env["HERMES_HOME"] ?? join(homedir(), ".hermes");
  const configPath = join(hermesHome, "config.yaml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }

  // Extract unique (base_url, api_key) pairs via lightweight regex parsing.
  // Covers both the `custom_providers:` list and the `providers:` map.
  const endpoints = new Map<string, string>(); // url -> api_key

  // custom_providers: list of {name, base_url, model, api_key?}
  const cpSection =
    content.match(/^custom_providers:\s*\n((?:[ \t]+-[^\n]*\n(?:[ \t][^\n]*\n)*)*)/m)?.[1] ?? "";
  for (const block of cpSection.split(/(?=^\s+-\s)/m).filter(Boolean)) {
    const url = (block.match(/base_url:\s*(\S+)/) ?? block.match(/url:\s*(\S+)/))?.[1]?.trim();
    const key = block.match(/api_key:\s*(\S+)/)?.[1]?.trim() ?? "";
    if (url) {
      // Add URL, or upgrade an existing keyless entry with a key we now have
      if (!endpoints.has(url) || (!endpoints.get(url) && key)) endpoints.set(url, key);
    }
  }

  // providers: map of name -> {api, api_key, default_model}
  const provSection = content.match(/^providers:\s*\n((?:[ \t][^\n]*\n)*)/m)?.[1] ?? "";
  const apiMatches = [...provSection.matchAll(/^\s+api:\s*(\S+)/gm)];
  const keyMatches = [...provSection.matchAll(/^\s+api_key:\s*(\S+)/gm)];
  for (let i = 0; i < apiMatches.length; i++) {
    const url = apiMatches[i]?.[1]?.trim();
    const key = keyMatches[i]?.[1]?.trim() ?? "";
    if (url && (!endpoints.has(url) || (!endpoints.get(url) && key))) endpoints.set(url, key);
  }

  if (endpoints.size === 0) return [];

  const fetched = await Promise.all(
    [...endpoints.entries()].map(([url, key]) => fetchOpenAIModels(url, key)),
  );

  const seen = new Set<string>();
  const results: { id: string; label: string }[] = [];
  for (const batch of fetched) {
    for (const m of batch) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        results.push(m);
      }
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
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
