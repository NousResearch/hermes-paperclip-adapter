import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROMPT_TEMPLATE, buildPrompt } from "../dist/server/execute.js";

test("DEFAULT_PROMPT_TEMPLATE includes artifact/attachment upload instructions", () => {
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes("attachments"));
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes("deliverable files"));
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes("download path / artifact link"));
});

test("buildPrompt renders file deliverable upload instructions for assigned task", () => {
  const ctx = {
    agent: { id: "agent-123", name: "Test Agent", companyId: "company-456" },
    config: {
      taskId: "issue-789",
      taskTitle: "Generate summary report",
      taskBody: "Create a PDF and CSV export",
    },
    runId: "run-abc",
  };

  const prompt = buildPrompt(ctx, {});
  assert.ok(prompt.includes("attachments"));
  assert.ok(prompt.includes("issue-789"));
  assert.ok(prompt.includes("Generate summary report"));
});
