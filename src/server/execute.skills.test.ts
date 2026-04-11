import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildExecutionPrompt } from "./execute.js";
import { buildDesiredSkillPromptData } from "./skills.js";

async function withTempSkill<T>(fn: (skillRoot: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-"));
  const skillRoot = path.join(tempDir, "copywriting");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      "---",
      "name: copywriting",
      "description: Copywriting workflow",
      "---",
      "Use tight, conversion-focused copy.",
    ].join("\n"),
    "utf8",
  );

  try {
    return await fn(skillRoot);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildConfig(skillRoot: string): Record<string, unknown> {
  return {
    paperclipRuntimeSkills: [
      {
        key: "copywriting",
        runtimeName: "copywriting",
        source: skillRoot,
      },
    ],
    paperclipSkillSync: {
      desiredSkills: ["copywriting"],
    },
  };
}

test("buildDesiredSkillPromptData loads selected runtime skill markdown", async () => {
  await withTempSkill(async (skillRoot) => {
    const result = await buildDesiredSkillPromptData(buildConfig(skillRoot));

    assert.deepEqual(result.desiredSkillNames, ["copywriting"]);
    assert.equal(result.warnings.length, 0);
    assert.match(result.promptSection, /# Paperclip-managed runtime skills/);
    assert.match(result.promptSection, /Use tight, conversion-focused copy\./);
  });
});

test("buildExecutionPrompt prepends skill instructions before wake prompt", async () => {
  await withTempSkill(async (skillRoot) => {
    const prompt = await buildExecutionPrompt(
      {
        agent: {
          id: "agent-1",
          name: "Skill Agent",
          companyId: "company-1",
        },
        config: {
          companyName: "Acme",
          projectName: "Demo",
        },
      } as any,
      buildConfig(skillRoot),
    );

    const skillIndex = prompt.indexOf("# Paperclip-managed runtime skills");
    const wakeIndex = prompt.indexOf("## Heartbeat Wake — Check for Work");

    assert.ok(skillIndex >= 0, "skill section should exist");
    assert.ok(wakeIndex >= 0, "wake prompt should exist");
    assert.ok(skillIndex < wakeIndex, "skill section should come before wake prompt");
  });
});
