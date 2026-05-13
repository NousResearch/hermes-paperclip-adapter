import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatSessionDisplayId,
  parseHermesOutput,
} from "./execute.js";

describe("parseHermesOutput", () => {
  it("extracts the full quiet-mode Hermes session id", () => {
    const parsed = parseHermesOutput("Done\n\nsession_id: 20260513_144718_6b34d7\n", "");

    assert.equal(parsed.sessionId, "20260513_144718_6b34d7");
    assert.equal(parsed.response, "Done");
  });

  it("does not parse a session id from Hermes session-not-found prose", () => {
    const parsed = parseHermesOutput(
      "Session not found: 20260513_144718_\r\nUse a session ID from a previous CLI run (hermes sessions list).\r\n",
      "",
    );

    assert.equal(parsed.sessionId, undefined);
    assert.match(parsed.response ?? "", /Session not found/);
  });

  it("ignores invalid quiet-mode session ids", () => {
    const parsed = parseHermesOutput("Done\n\nsession_id: from\n", "");

    assert.equal(parsed.sessionId, undefined);
  });

  it("accepts only anchored legacy Hermes session lines", () => {
    const parsed = parseHermesOutput("Session saved: 20260513_144718_6b34d7\n", "");

    assert.equal(parsed.sessionId, "20260513_144718_6b34d7");
  });
});

describe("formatSessionDisplayId", () => {
  it("marks shortened display ids as non-executable", () => {
    assert.equal(formatSessionDisplayId("20260513_144718_6b34d7"), "20260513_144718_...");
  });
});
