/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Hermes session IDs follow the format `YYYYMMDD_HHMMSS_<hex>`, e.g.
 * `20260513_091310_fb8871`. Anything that does not match — such as the
 * word `"from"` accidentally captured from error output — is rejected.
 */
const HERMES_SESSION_ID_RE = /^\d{8}_\d{6}_[a-f0-9]+$/;

function readValidSessionId(value: unknown): string | null {
  const s = readNonEmptyString(value);
  if (!s || !HERMES_SESSION_ID_RE.test(s)) return null;
  return s;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field,
 * rejecting values that do not match the Hermes session ID format.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readValidSessionId(record.sessionId) ??
      readValidSessionId(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readValidSessionId(params.sessionId) ??
      readValidSessionId(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readValidSessionId(params.sessionId) ?? readValidSessionId(params.session_id);
  },
};
