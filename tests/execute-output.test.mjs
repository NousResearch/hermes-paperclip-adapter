import assert from "node:assert/strict";
import test from "node:test";

import { parseHermesOutput } from "../dist/server/execute.js";

test("uses only terminal assistant lines for verbose Hermes output", () => {
  const parsed = parseHermesOutput(
    [
      "Model: gpt-5",
      "## Reasoning",
      "Read issue context and invoke tools.",
      "[done] ┊ 💻 $ curl -s http://127.0.0.1:3100/api/issues/WEI-1  0.1s",
      "┊ 💬 Fixed the publication path; regression check passed.",
      "session_id: run-123",
    ].join("\n"),
    "",
  );

  assert.equal(parsed.response, "Fixed the publication path; regression check passed.");
  assert.equal(parsed.sessionId, "run-123");
});

test("retains quiet-mode terminal output", () => {
  const parsed = parseHermesOutput("Completed bounded verification.\nsession_id: run-456", "");

  assert.equal(parsed.response, "Completed bounded verification.");
  assert.equal(parsed.sessionId, "run-456");
});