import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execute } from "../dist/server/execute.js";

async function makeFakeHermesCommand() {
  const dir = await mkdtemp(join(tmpdir(), "hermes-adapter-test-"));
  const command = join(dir, "fake-hermes.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.HERMES_FAKE_ARGV_FILE) {
  writeFileSync(process.env.HERMES_FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
}
if (process.env.HERMES_FAKE_STDOUT) process.stdout.write(process.env.HERMES_FAKE_STDOUT);
if (process.env.HERMES_FAKE_STDERR) process.stderr.write(process.env.HERMES_FAKE_STDERR);
process.exit(Number(process.env.HERMES_FAKE_EXIT_CODE || "0"));
`,
    "utf8",
  );
  await chmod(command, 0o755);
  return command;
}

function makeContext(config = {}, runtime = {}) {
  const logs = [];
  return {
    runId: "run-test",
    config,
    runtime,
    agent: {
      id: "agent-test",
      name: "Hermes Test Agent",
      companyId: "company-test",
      adapterConfig: {},
    },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    logs,
  };
}

test("execute preserves the full Hermes session id as the display id", async () => {
  const hermesCommand = await makeFakeHermesCommand();
  const sessionId = "20260518_175454_0af855";
  const ctx = makeContext({
    hermesCommand,
    model: "gpt-5.5",
    env: {
      HERMES_FAKE_STDOUT: `Agent finished.\n\nsession_id: ${sessionId}\n`,
    },
  });

  const result = await execute(ctx);

  assert.deepEqual(result.sessionParams, { sessionId });
  assert.equal(result.sessionDisplayId, sessionId);
  assert.equal(result.resultJson?.session_id, sessionId);
});

test("execute captures the canonical session id from quiet-mode stderr", async () => {
  const hermesCommand = await makeFakeHermesCommand();
  const sessionId = "20260518_175454_0af855";
  const ctx = makeContext({
    hermesCommand,
    model: "gpt-5.5",
    env: {
      HERMES_FAKE_STDOUT: "Agent finished.\n",
      HERMES_FAKE_STDERR: `session_id: ${sessionId}\n`,
    },
  });

  const result = await execute(ctx);

  assert.deepEqual(result.sessionParams, { sessionId });
  assert.equal(result.sessionDisplayId, sessionId);
  assert.equal(result.resultJson?.session_id, sessionId);
  assert.equal(result.summary, "Agent finished.");
});

test("execute ignores invalid session ids parsed from Hermes error/help output", async () => {
  const hermesCommand = await makeFakeHermesCommand();
  const ctx = makeContext({
    hermesCommand,
    model: "gpt-5.5",
    env: {
      HERMES_FAKE_STDERR:
        "Session not found: from\nUse a session ID from a previous CLI run (hermes sessions list).\n",
      HERMES_FAKE_EXIT_CODE: "1",
    },
  });

  const result = await execute(ctx);

  assert.equal(result.exitCode, 1);
  assert.equal(result.sessionParams, undefined);
  assert.equal(result.sessionDisplayId, undefined);
  assert.equal(result.resultJson?.session_id, null);
});

test("execute does not pass invalid persisted session ids to --resume", async () => {
  const hermesCommand = await makeFakeHermesCommand();
  const dir = await mkdtemp(join(tmpdir(), "hermes-adapter-argv-"));
  const argvFile = join(dir, "argv.json");
  const sessionId = "20260518_175454_0af855";
  const ctx = makeContext(
    {
      hermesCommand,
      model: "gpt-5.5",
      env: {
        HERMES_FAKE_ARGV_FILE: argvFile,
        HERMES_FAKE_STDOUT: `Recovered.\n\nsession_id: ${sessionId}\n`,
      },
    },
    { sessionParams: { sessionId: "from" } },
  );

  const result = await execute(ctx);
  const argv = JSON.parse(await readFile(argvFile, "utf8"));

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionParams?.sessionId, sessionId);
  assert.equal(argv.includes("--resume"), false);
  assert.equal(argv.includes("from"), false);
});
