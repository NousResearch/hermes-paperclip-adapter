import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { execute } from "../dist/server/execute.js";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  await execFile("git", ["-C", cwd, ...args]);
}

async function createWorkspace(branch = "realized-workspace") {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-paperclip-workspace-"));
  await git(cwd, "init", "--initial-branch", branch);
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Adapter Test");
  await writeFile(join(cwd, "README.md"), "fixture\n");
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "-m", "fixture");
  await git(cwd, "remote", "add", "origin", "https://credential@example.test/controlled/workspace.git");
  return cwd;
}

function withWorkspaceEnv(cwd, branch) {
  const previous = {
    cwd: process.env.PAPERCLIP_WORKSPACE_CWD,
    branch: process.env.PAPERCLIP_WORKSPACE_BRANCH,
  };
  process.env.PAPERCLIP_WORKSPACE_CWD = cwd;
  process.env.PAPERCLIP_WORKSPACE_BRANCH = branch;
  return () => {
    if (previous.cwd === undefined) delete process.env.PAPERCLIP_WORKSPACE_CWD;
    else process.env.PAPERCLIP_WORKSPACE_CWD = previous.cwd;
    if (previous.branch === undefined) delete process.env.PAPERCLIP_WORKSPACE_BRANCH;
    else process.env.PAPERCLIP_WORKSPACE_BRANCH = previous.branch;
  };
}

function executionContext(config) {
  return {
    runId: "run-workspace-test",
    config,
    agent: { name: "Workspace Test Agent" },
    onLog: async () => {},
  };
}

test("passes the verified realized workspace to the Hermes child process", async () => {
  const cwd = await createWorkspace();
  const restoreEnv = withWorkspaceEnv(cwd, "realized-workspace");
  let invocation;
  try {
    const result = await execute(
      executionContext({ provider: "openai", cwd }),
      async (runId, command, args, options) => {
        invocation = { runId, command, args, options };
        return { exitCode: 0, signal: null, timedOut: false, stdout: "done", stderr: "" };
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(invocation.options.cwd, await realpath(cwd));
    assert.equal(invocation.options.env.PAPERCLIP_WORKSPACE_CWD, cwd);
  } finally {
    restoreEnv();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects an explicit adapter cwd mismatch before starting the Hermes child process", async () => {
  const workspaceCwd = await createWorkspace();
  const otherCwd = await createWorkspace("other-workspace");
  const restoreEnv = withWorkspaceEnv(workspaceCwd, "realized-workspace");
  let childStarted = false;
  try {
    const result = await execute(
      executionContext({ provider: "openai", cwd: otherCwd }),
      async () => {
        childStarted = true;
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      },
    );

    assert.equal(childStarted, false);
    assert.match(result.errorMessage, /explicit adapter cwd does not match registered workspace/);
  } finally {
    restoreEnv();
    await Promise.all([
      rm(workspaceCwd, { recursive: true, force: true }),
      rm(otherCwd, { recursive: true, force: true }),
    ]);
  }
});

test("rejects a workspace branch mismatch before starting the Hermes child process", async () => {
  const cwd = await createWorkspace();
  const restoreEnv = withWorkspaceEnv(cwd, "expected-branch");
  let childStarted = false;
  const logs = [];
  try {
    const result = await execute(
      { ...executionContext({ provider: "openai" }), onLog: async (stream, message) => logs.push({ stream, message }) },
      async () => {
        childStarted = true;
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      },
    );

    assert.equal(childStarted, false);
    assert.match(result.errorMessage, /checked-out branch does not match PAPERCLIP_WORKSPACE_BRANCH/);
    assert.match(result.errorMessage, /origin=https:\/\/example\.test\/controlled\/workspace\.git/);
    assert.doesNotMatch(result.errorMessage, /credential/);
    assert.equal(logs.length, 1);
  } finally {
    restoreEnv();
    await rm(cwd, { recursive: true, force: true });
  }
});
