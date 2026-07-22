import test from "node:test";
import assert from "node:assert/strict";

import { VALID_PROVIDERS } from "../dist/shared/constants.js";
import { inferProviderFromModel, resolveProvider } from "../dist/server/detect-model.js";

test("xAI/Grok providers are valid explicit Hermes providers", () => {
  assert.equal(VALID_PROVIDERS.includes("xai"), true);
  assert.equal(VALID_PROVIDERS.includes("xai-oauth"), true);
  assert.deepEqual(resolveProvider({ explicitProvider: "xai-oauth", model: "grok-4.3" }), {
    provider: "xai-oauth",
    resolvedFrom: "adapterConfig",
  });
});

test("Grok model names infer xai-oauth instead of falling back to auto", () => {
  assert.equal(inferProviderFromModel("grok-4.3"), "xai-oauth");
  assert.equal(inferProviderFromModel("grok/grok-4.3"), "xai-oauth");
  assert.deepEqual(resolveProvider({ model: "grok-4.3" }), {
    provider: "xai-oauth",
    resolvedFrom: "modelInference",
  });
});
