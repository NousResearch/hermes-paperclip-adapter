import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";
import { parseModelFromConfig } from "./server/detect-model.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

// ── Curated model list + auto-detect Hermes default ───────────────────
const CURATED_MODELS: { id: string; label: string }[] = [
  { id: "", label: "Auto (use Hermes default)" },
  // OpenCode Go
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (OpenCode Go)" },
  { id: "deepseek-v4", label: "DeepSeek V4 (OpenCode Go)" },
  { id: "deepseek-v3", label: "DeepSeek V3 (OpenCode Go)" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex (OpenCode Go)" },
  // OpenCode Zen
  { id: "claude-sonnet-4", label: "Claude Sonnet 4 (OpenCode Zen)" },
  { id: "claude-opus-4", label: "Claude Opus 4 (OpenCode Zen)" },
  { id: "gpt-5.4", label: "GPT-5.4 (OpenCode Zen)" },
  { id: "o4-mini", label: "o4-mini (OpenCode Zen)" },
  // Gemini
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  // Grok / xAI
  { id: "grok-4", label: "Grok 4 (xAI)" },
  { id: "grok-4.3", label: "Grok 4.3 (xAI)" },
  // OpenRouter popular
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (OpenRouter)" },
  { id: "openai/gpt-5.4", label: "GPT-5.4 (OpenRouter)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (OpenRouter)" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash (OpenRouter)" },
  // Ollama local
  { id: "llama-3.2", label: "Llama 3.2 (Ollama)" },
  { id: "qwen2.5", label: "Qwen 2.5 (Ollama)" },
  { id: "mistral", label: "Mistral (Ollama)" },
];

// ── Populate models ───────────────────────────────────────────────────
// Strategy: curated list + auto-detected Hermes default model.
// In the future this can also fetch the Hermes model catalog for full
// dynamic discovery.
export const models: { id: string; label: string }[] = (() => {
  const result = [...CURATED_MODELS];

  // Auto-detect the user's configured model and add it prominently
  try {
    const configPath = join(homedir(), ".hermes", "config.yaml");
    const content = readFileSync(configPath, "utf-8");
    const detected = parseModelFromConfig(content);

    if (detected?.model) {
      // Move user's config model to the top of the list
      const idx = result.findIndex((m) => m.id === detected.model);
      const label = detected.provider
        ? `${detected.model} (${detected.provider} — Hermes default)`
        : `${detected.model} (Hermes default)`;

      if (idx >= 0) {
        result[idx] = { ...result[idx], label };
        // Move to top (after Auto)
        const entry = result.splice(idx, 1)[0];
        result.splice(1, 0, entry);
      } else {
        result.splice(1, 0, { id: detected.model, label });
      }
    }
  } catch {
    // Config file doesn't exist — curated list still available
  }

  return result;
})();

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
| provider | string | (auto) | API provider. Usually not needed — Hermes auto-detects from model name. |
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
\`;