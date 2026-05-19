import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  extractLegacySessionId,
  formatSessionDisplayId,
  isValidHermesSessionId,
} from "./session-id.js";

test("accepts canonical Hermes session IDs", () => {
  assert.equal(isValidHermesSessionId("20260518_175454_0af855"), true);
  assert.equal(isValidHermesSessionId("20260518_175454_abcdef-XYZ_123"), true);
});

test("rejects stray tokens and error text as session IDs", () => {
  assert.equal(isValidHermesSessionId("from"), false);
  assert.equal(isValidHermesSessionId("20260518_175454_"), false);
  assert.equal(
    extractLegacySessionId(
      "Session not found: from\nUse a session ID from a previous CLI run (hermes sessions list).",
    ),
    null,
  );
});

test("legacy parser still accepts canonical session-id lines", () => {
  assert.equal(
    extractLegacySessionId("session saved: 20260518_175454_0af855"),
    "20260518_175454_0af855",
  );
  assert.equal(
    extractLegacySessionId("session id: 20260518_175454_0af855"),
    "20260518_175454_0af855",
  );
});

test("session display id preserves the full Hermes session id", () => {
  assert.equal(
    formatSessionDisplayId("20260518_175454_0af855"),
    "20260518_175454_0af855",
  );
});