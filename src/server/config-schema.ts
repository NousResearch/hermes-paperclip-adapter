/**
 * Declarative config schema for the Hermes Agent adapter.
 *
 * Returns a schema so the Paperclip UI can render Hermes-specific
 * form fields (provider, profile, toolsets) dynamically.
 */

import type { AdapterConfigSchema, ConfigFieldOption } from "@paperclipai/adapter-utils";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { VALID_PROVIDERS } from "../shared/constants.js";
import { detectModel } from "./detect-model.js";

const PROVIDER_LABELS: Record<string, string> = {
  auto: "Auto-detect",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-codex": "OpenAI (Codex)",
  copilot: "GitHub Copilot",
  "copilot-acp": "Copilot ACP",
  nous: "Nous Research",
  huggingface: "HuggingFace",
  zai: "Z.AI (GLM)",
  "kimi-coding": "Kimi Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (CN)",
  kilocode: "Kilocode",
};

async function scanProfiles(): Promise<ConfigFieldOption[]> {
  const options: ConfigFieldOption[] = [
    { label: "Default (no profile)", value: "" },
  ];
  try {
    const profilesDir = join(homedir(), ".hermes", "profiles");
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        options.push({ label: entry.name, value: entry.name });
      }
    }
  } catch {
    // No profiles directory — only show default option
  }
  return options;
}

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  const providerOptions: ConfigFieldOption[] = VALID_PROVIDERS.map((p) => ({
    label: PROVIDER_LABELS[p] || p,
    value: p,
  }));

  let detectedHint = "";
  try {
    const detected = await detectModel();
    if (detected) {
      detectedHint = ` Detected from config: ${detected.model}` +
        (detected.provider ? ` (${detected.provider})` : "");
    }
  } catch {
    // Non-fatal
  }

  const profileOptions = await scanProfiles();

  return {
    fields: [
      {
        key: "provider",
        label: "Inference Provider",
        type: "combobox",
        options: providerOptions,
        default: "auto",
        hint: `Which LLM provider to use. "Auto-detect" reads from ~/.hermes/config.yaml or infers from model name.${detectedHint}`,
        required: false,
      },
      {
        key: "profile",
        label: "Hermes Profile",
        type: "select",
        options: profileOptions,
        default: "",
        hint: "Each profile has its own config, memory, skills, and session state. Recommended for running multiple agents.",
        required: false,
      },
      {
        key: "toolsets",
        label: "Enabled Toolsets",
        type: "text",
        hint: "Comma-separated Hermes toolsets (e.g. terminal,file,web,browser,mcp). Leave blank for Hermes defaults.",
        required: false,
      },
    ],
  };
}
