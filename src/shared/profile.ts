/**
 * Profile resolution helpers for the Hermes Agent adapter.
 *
 * Hermes supports fully isolated profiles at ~/.hermes/profiles/<name>/,
 * each with its own config, state, skills, and memory. These helpers
 * resolve the correct HERMES_HOME directory from adapter config.
 */

import os from "node:os";
import path from "node:path";

/**
 * Extract a profile name from adapter config.
 *
 * Checks (in priority order):
 *   1. config.profile (explicit field from getConfigSchema)
 *   2. -p / --profile in config.extraArgs
 *
 * Returns the profile name string, or null if no profile is configured.
 */
export function extractProfileName(config: Record<string, unknown>): string | null {
  // 1. Explicit profile field
  const profile = config.profile;
  if (typeof profile === "string" && profile.trim()) return profile.trim();

  // 2. -p / --profile in extraArgs
  const extraArgs = config.extraArgs;
  if (Array.isArray(extraArgs)) {
    for (let i = 0; i < extraArgs.length; i++) {
      const arg = String(extraArgs[i]);
      if (arg === "-p" || arg === "--profile") {
        const next = extraArgs[i + 1];
        if (typeof next === "string" && next.trim()) return next.trim();
      }
      const eqMatch = arg.match(/^--profile=(.+)$/);
      if (eqMatch) return eqMatch[1].trim();
    }
  }

  return null;
}

/**
 * Resolve the effective HERMES_HOME directory.
 *
 * Priority:
 *   1. Explicit HERMES_HOME in config.env
 *   2. Profile name → ~/.hermes/profiles/<name>
 *   3. Default → ~/.hermes
 */
export function resolveHermesHomeDir(config: Record<string, unknown>): string {
  // 1. Explicit HERMES_HOME in env
  const envConfig = config.env;
  if (envConfig && typeof envConfig === "object" && !Array.isArray(envConfig)) {
    const hermesHome = (envConfig as Record<string, unknown>).HERMES_HOME;
    if (typeof hermesHome === "string" && hermesHome.trim()) {
      return hermesHome.trim();
    }
    // Handle wrapped format: { type: "plain", value: "..." }
    if (hermesHome && typeof hermesHome === "object" && "value" in hermesHome) {
      const val = (hermesHome as Record<string, unknown>).value;
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }

  // 2. Profile name
  const profile = extractProfileName(config);
  if (profile) {
    return path.join(os.homedir(), ".hermes", "profiles", profile);
  }

  // 3. Default
  return path.join(os.homedir(), ".hermes");
}
