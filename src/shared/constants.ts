/**
 * Shared constants for the Hermes Agent adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/** Default CLI binary name. */
export const HERMES_CLI = "hermes";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Default model to use if none specified. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 */
export const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Model-name prefix -> provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  // OpenAI-native models
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  // Anthropic models
  ["claude", "anthropic"],
  // Google models (via openrouter or direct)
  ["gemini", "auto"],
  // Nous models
  ["hermes-", "nous"],
  // Z.AI / GLM models
  ["glm-", "zai"],
  // Kimi / Moonshot
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  // MiniMax
  ["minimax", "minimax"],
  // DeepSeek
  ["deepseek", "auto"],
  // Meta Llama
  ["llama", "auto"],
  // Qwen
  ["qwen", "auto"],
  // Mistral
  ["mistral", "auto"],
  // HuggingFace models (org/model format)
  ["huggingface/", "huggingface"],
];

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "\u2502";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "\U0001f4ad";

// ---------------------------------------------------------------------------
// 3-tier model fallback
// ---------------------------------------------------------------------------

/**
 * Trigger conditions for a tier fallback.
 * Any match = this tier failed, try the next.
 */
export const FALLBACK_ERROR_PATTERNS = [
  /429\s+(?:rate\s*limit|limit exceeded|quota)/i,
  /rate\s*limit/i,
  /cap(?:\s+exceeded|\s+reached|\s*limit)/i,
  /too\s+many\s+requests/i,
  /quota\s+exceeded/i,
  /\b500\b.*?(?:internal\s+)?server\s+error/i,
  /\b503\b\s+Service\s+Unavail/i,
  /\b502\b\s+Bad\s+Gateway/i,
  /\b504\b\s+Gateway\s+Timeout/i,
  /provider\s+(?:is\s+)?down/i,
  /upstream\s+timeout/i,
  /connection\s+(?:refused|reset|timeout)/i,
];

/**
 * Daily spend ceiling per fallback tier (USD).
 * Process restart resets the counter (acceptable for MVP).
 * Can be overridden per-agent via adapterConfig.fallbackTiers[tierN].dailyBudgetUsd.
 */
export const DEFAULT_TIER_DAILY_SPEND_LIMIT_USD = 5;

/**
 * A single fallback tier definition.
 */
export interface FallbackTier {
  /** 1-based tier number */
  tier: number;
  /** Human label */
  label: string;
  /** Model to use (may be same as primary for tier 2) */
  model: string;
  /** Provider to use */
  provider: string;
  /**
   * Override for MINIMAX_API_KEY env var (tier 2 only — PAYG key).
   * null = inherit from current process env.
   */
  minimaxApiKeyOverride?: string;
  /** Env var name to check for the API key (tier 2 = MINIMAX_PAYG_KEY) */
  apiKeyEnvVar?: string;
  /** Daily spend limit in USD (null = no limit) */
  dailySpendLimitUsd?: number | null;
  /**
   * Regex patterns that trigger fallback to the next tier.
   * Any pattern matching in combined stdout+stderr = try next tier.
   */
  errorPatterns?: RegExp[];
}

/**
 * 3-tier fallback chain.
 *
 * Tier 1 (primary): MiniMax plan key (MINIMAX_API_KEY, flat $10/month).
 *   Trigger: HTTP 429 (plan cap) or MiniMax 5xx.
 *   Model: MiniMax-M2.7, Provider: minimax.
 *
 * Tier 2 (cap overflow): MiniMax PAYG key (MINIMAX_PAYG_KEY, per-token ~$0.05/run).
 *   Trigger: Tier 1 returns rate-limit or 5xx.
 *   Model: MiniMax-M2.7, Provider: minimax (MINIMAX_API_KEY swapped to PAYG key).
 *   Rationale: same model, different billing account — no quality change.
 *
 * Tier 3 (provider outage): Kimi K2.5 via OpenRouter (different infra).
 *   Trigger: Tier 2 also fails or MiniMax is down as a provider.
 *   Model: moonshotai/kimi-k2.5, Provider: kimi-coding.
 *   Cost: ~$0.10/run via OpenRouter.
 *
 * If all 3 tiers fail -> return tier-3 error (no further fallback).
 */
export const FALLBACK_TIERS: FallbackTier[] = [
  {
    tier: 1,
    label: "MiniMax Plan (primary)",
    model: "MiniMax-M2.7",
    provider: "minimax",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    dailySpendLimitUsd: null, // flat plan, no per-run cost concern
    errorPatterns: FALLBACK_ERROR_PATTERNS,
  },
  {
    tier: 2,
    label: "MiniMax PAYG (cap overflow)",
    model: "MiniMax-M2.7",
    provider: "minimax",
    minimaxApiKeyOverride: process.env["MINIMAX_PAYG_KEY"] ?? undefined,
    apiKeyEnvVar: "MINIMAX_PAYG_KEY",
    dailySpendLimitUsd: DEFAULT_TIER_DAILY_SPEND_LIMIT_USD,
    errorPatterns: FALLBACK_ERROR_PATTERNS,
  },
  {
    tier: 3,
    label: "Kimi K2.5 via OpenRouter (provider outage)",
    model: "moonshotai/kimi-k2.5",
    provider: "kimi-coding",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    dailySpendLimitUsd: DEFAULT_TIER_DAILY_SPEND_LIMIT_USD,
    errorPatterns: FALLBACK_ERROR_PATTERNS,
  },
];
