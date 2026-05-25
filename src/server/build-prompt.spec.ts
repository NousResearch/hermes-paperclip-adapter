/**
 * Unit tests for buildPrompt's wake-data source resolution.
 *
 * Reproduces the bug fixed by this PR:
 *   Paperclip's heartbeat service passes wake metadata in `ctx.context`
 *   (the contextSnapshot from the heartbeat_runs row), not in `ctx.config`
 *   (the adapter's runtimeConfig). The previous implementation only read
 *   from `ctx.config.taskId`, so every wake — including @-mention comments
 *   and direct task assignments — fell through to the `{{#noTask}}` branch
 *   and Hermes agents replied with "No assigned Paperclip work" instead of
 *   doing the assigned task.
 *
 * Run with: npm test (after build).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { buildPrompt } from "./execute.js";

function makeCtx(
  overrides: Partial<AdapterExecutionContext> & {
    context?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
): AdapterExecutionContext {
  return {
    runId: "run-test",
    agent: {
      id: "agent-1",
      name: "TestBot",
      companyId: "co-1",
      adapterConfig: {},
    } as AdapterExecutionContext["agent"],
    runtime: {} as AdapterExecutionContext["runtime"],
    config: overrides.config ?? {},
    context: overrides.context ?? {},
    onLog: async () => {},
  } as AdapterExecutionContext;
}

test("buildPrompt: renders {{#taskId}} branch when ctx.context.taskId is set (regression: HUM-101)", () => {
  // This is the exact shape Paperclip's heartbeat service passes — taskId
  // lives on ctx.context, NOT ctx.config. Before the fix, this case fell
  // through to the {{#noTask}} branch because the adapter only checked
  // ctx.config.taskId.
  const ctx = makeCtx({
    context: {
      taskId: "HUM-101",
      paperclipIssue: {
        id: "HUM-101",
        title: "Hermes adapter wake bug",
        description: "Wake metadata is being dropped.",
      },
    },
  });

  const prompt = buildPrompt(ctx, {});

  assert.match(prompt, /Issue ID: HUM-101/, "should include the task ID");
  assert.match(
    prompt,
    /Title: Hermes adapter wake bug/,
    "should pull title from ctx.context.paperclipIssue",
  );
  assert.match(
    prompt,
    /Wake metadata is being dropped\./,
    "should pull body from ctx.context.paperclipIssue.description",
  );
  assert.doesNotMatch(
    prompt,
    /Heartbeat Wake — Check for Work/,
    "must NOT fall through to the {{#noTask}} branch",
  );
});

test("buildPrompt: renders {{#noTask}} branch when neither ctx.context nor ctx.config has a taskId", () => {
  const prompt = buildPrompt(makeCtx(), {});

  assert.match(
    prompt,
    /Heartbeat Wake — Check for Work/,
    "no-task wakes should render the heartbeat branch",
  );
  assert.doesNotMatch(
    prompt,
    /## Assigned Task/,
    "must not render the assigned-task branch",
  );
});

test("buildPrompt: ctx.config.taskId still works (backwards compatibility)", () => {
  // Any pre-existing caller that populated ctx.config.taskId directly must
  // continue to work — ctx.config is the documented fallback.
  const ctx = makeCtx({
    config: {
      taskId: "HUM-9",
      taskTitle: "Legacy task",
      taskBody: "Plumbed via ctx.config.",
    },
  });

  const prompt = buildPrompt(ctx, {});

  assert.match(prompt, /Issue ID: HUM-9/);
  assert.match(prompt, /Title: Legacy task/);
  assert.match(prompt, /Plumbed via ctx\.config\./);
});

test("buildPrompt: ctx.config wins over ctx.context when both are set (backwards-compat order)", () => {
  // The lookup order is ctx.config → ctx.context, so any pre-existing caller
  // that populates ctx.config.taskId keeps its behavior. In real Paperstack
  // heartbeats ctx.config.taskId is never populated, so ctx.context is the
  // effective source.
  const ctx = makeCtx({
    config: { taskId: "HUM-CFG" },
    context: { taskId: "HUM-CTX" },
  });

  const prompt = buildPrompt(ctx, {});

  assert.match(prompt, /Issue ID: HUM-CFG/);
});

test("buildPrompt: ctx.context.wakeCommentId triggers {{#commentId}} branch", () => {
  const ctx = makeCtx({
    context: {
      taskId: "HUM-101",
      wakeCommentId: "comment-42",
      paperclipIssue: { id: "HUM-101", title: "T", description: "B" },
    },
  });

  const prompt = buildPrompt(ctx, {});

  assert.match(prompt, /## Comment on This Issue/);
  assert.match(prompt, /comment-42/);
});

test("buildPrompt: ctx.context.issueId is accepted as an alias for taskId", () => {
  // Some Paperclip code paths use `issueId` rather than `taskId` in the
  // contextSnapshot. Accept both.
  const ctx = makeCtx({
    context: { issueId: "HUM-999" },
  });

  const prompt = buildPrompt(ctx, {});

  assert.match(prompt, /Issue ID: HUM-999/);
});
