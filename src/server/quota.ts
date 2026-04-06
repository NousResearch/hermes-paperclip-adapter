/**
 * Quota windows for the Hermes Agent adapter.
 *
 * Hermes supports 13+ providers with no single quota API.
 * Returns an empty-but-valid result. Future versions can query
 * provider-specific usage APIs (OpenRouter /api/v1/auth/key,
 * Anthropic /api/oauth/usage, etc.).
 */

import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  return {
    provider: "hermes",
    ok: true,
    source: "hermes-adapter",
    windows: [],
  };
}
