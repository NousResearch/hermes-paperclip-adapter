/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { parseHermesOutput, isHermesUnknownSessionError, isHermesMaxTurnsResult, cleanResponse } from "./parse.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";
export { getConfigSchema } from "./config-schema.js";
export { getQuotaWindows } from "./quota.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const result: Record<string, string> = { sessionId };
    const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir);
    if (cwd) result.cwd = cwd;
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    if (workspaceId) result.workspaceId = workspaceId;
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    if (repoUrl) result.repoUrl = repoUrl;
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    if (repoRef) result.repoRef = repoRef;
    return result;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId);
    if (!sessionId) return null;
    const result: Record<string, string> = { sessionId };
    const cwd = readNonEmptyString(params.cwd);
    if (cwd) result.cwd = cwd;
    const workspaceId = readNonEmptyString(params.workspaceId);
    if (workspaceId) result.workspaceId = workspaceId;
    const repoUrl = readNonEmptyString(params.repoUrl);
    if (repoUrl) result.repoUrl = repoUrl;
    const repoRef = readNonEmptyString(params.repoRef);
    if (repoRef) result.repoRef = repoRef;
    return result;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
