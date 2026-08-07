import assert from "node:assert/strict";
import test from "node:test";

import { buildModelArgs, hasProfileArg } from "./execute.js";

test("profile arguments are recognized in both supported forms", () => {
  assert.equal(hasProfileArg(["--profile", "paco-consulting"]), true);
  assert.equal(hasProfileArg(["-p=paco-consulting"]), true);
  assert.equal(hasProfileArg(["--verbose"]), false);
});

test("profile-selected execution does not emit a model override", () => {
  assert.deepEqual(buildModelArgs("auto"), []);
  assert.deepEqual(buildModelArgs("openai/gpt-5"), ["-m", "openai/gpt-5"]);
});
