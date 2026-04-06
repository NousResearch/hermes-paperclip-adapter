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

import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";
import {
  execute,
  sessionCodec,
  testEnvironment,
  listSkills,
  syncSkills,
  getConfigSchema,
  getQuotaWindows,
} from "./server/index.js";
import { detectModel } from "./server/detect-model.js";

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
 * Enable Paperclip to mint a per-run JWT for this adapter.
 * The JWT is passed as ctx.authToken and injected as PAPERCLIP_API_KEY.
 */
export const supportsLocalAgentJwt = true;

// Re-export server functions for direct import convenience
export { execute, sessionCodec, listSkills, syncSkills, testEnvironment, detectModel, getConfigSchema, getQuotaWindows };

/**
 * Factory function for the Paperclip external adapter plugin loader.
 *
 * plugin-loader.ts calls createServerAdapter() and expects a complete
 * ServerAdapterModule. This lets the hermes adapter work both as a
 * builtin (registry.ts picks individual exports) and as an installable
 * npm plugin.
 */
export function createServerAdapter() {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    listSkills,
    syncSkills,
    models,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc,
    detectModel: () => detectModel(),
    getConfigSchema,
    getQuotaWindows,
  };
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
| provider | string | (auto) | Inference provider override (e.g. anthropic, openrouter, nous). If not set, auto-detected from ~/.hermes/config.yaml or inferred from model name. |
| timeoutSec | number | 300 | Execution timeout in seconds |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL |

## Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| toolsets | string | (all) | Comma-separated Hermes toolsets to enable (e.g. "terminal,file,web,browser,mcp"). If not set, Hermes uses its default toolset configuration. |

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
| env | object | {} | Environment variables passed to the Hermes process. Supports plain strings and \`{ type: "secret_ref", secretId: "..." }\` format for secrets managed by Paperclip. |
| instructionsFilePath | string | (none) | Path to the agent's AGENTS.md instructions file. Managed by the Paperclip Instructions tab. Content is prepended to the prompt on every heartbeat. |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |
| bootstrapPromptTemplate | string | (none) | Prompt template used only on the first heartbeat (no session to resume). Omitted on subsequent runs to reduce token waste. Supports the same {{variables}} as promptTemplate. |

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
