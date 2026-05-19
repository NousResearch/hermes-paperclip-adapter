export const HERMES_SESSION_ID_PATTERN = /^\d{8}_\d{6}_[a-zA-Z0-9_-]+$/;

export const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

export const SESSION_ID_REGEX_LEGACY =
  /session[_ ](?:id|saved)[:\s]+(\d{8}_\d{6}_[a-zA-Z0-9_-]+)/i;

export function isValidHermesSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && HERMES_SESSION_ID_PATTERN.test(value);
}

export function extractLegacySessionId(text: string): string | null {
  const match = text.match(SESSION_ID_REGEX_LEGACY);
  return match?.[1] ?? null;
}

export function formatSessionDisplayId(sessionId: string): string {
  return sessionId;
}