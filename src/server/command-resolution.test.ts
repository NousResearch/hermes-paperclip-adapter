import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  assert.equal(
    resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }),
    "hermes_maximus",
  );
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  assert.equal(resolveHermesCommand({ command: "hermes_maximus" }), "hermes_maximus");
  assert.equal(resolveHermesCommand({}), HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    assert.notEqual(result.status, "fail");
    assert.equal(
      result.checks.some((check) => check.code === "hermes_cli_not_found"),
      false,
    );
    assert.equal(
      result.checks.some(
        (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
      ),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
