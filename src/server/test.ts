/**
 * Environment test for the Hermes Agent adapter.
 *
 * Verifies that Hermes Agent is installed, accessible, and configured
 * before allowing the adapter to be used.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

import { HERMES_CLI, DEFAULT_MODEL, ADAPTER_TYPE, VALID_PROVIDERS } from "../shared/constants.js";
import { detectModel, resolveProvider, inferProviderFromModel } from "./detect-model.js";

const execFileAsync = promisify(execFile);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    // Try to run the command to see if it exists
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return null; // OK — it ran successfully
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${command}" not found in PATH`,
        hint: "Install Hermes Agent: pip install hermes-agent",
        code: "hermes_cli_not_found",
      };
    }
    // Command exists but --version might have failed for some reason
    // Still consider it installed
    return null;
  }
}

async function checkCliVersion(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
    });
    const version = stdout.trim();
    if (version) {
      return {
        level: "info",
        message: `Hermes Agent version: ${version}`,
        code: "hermes_version",
      };
    }
    return {
      level: "warn",
      message: "Could not determine Hermes Agent version",
      code: "hermes_version_unknown",
    };
  } catch {
    return {
      level: "warn",
      message:
        "Could not determine Hermes Agent version (hermes --version failed)",
      hint: "Make sure the hermes CLI is properly installed and functional",
      code: "hermes_version_failed",
    };
  }
}

async function checkPython(): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync("python3", ["--version"], {
      timeout: 5_000,
    });
    const version = stdout.trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < 3 || (major === 3 && minor < 10)) {
        return {
          level: "error",
          message: `Python ${version} found — Hermes requires Python 3.10+`,
          hint: "Upgrade Python to 3.10 or later",
          code: "hermes_python_old",
        };
      }
    }
    return null; // OK
  } catch {
    return {
      level: "warn",
      message: "python3 not found in PATH",
      hint: "Hermes Agent requires Python 3.10+. Install it from python.org",
      code: "hermes_python_missing",
    };
  }
}

function checkModel(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const model = asString(config.model);
  if (!model) {
    return {
      level: "info",
      message: "No model specified — Hermes will use its configured default model",
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return {
    level: "info",
    message: `Model: ${model}`,
    code: "hermes_model_configured",
  };
}

function checkApiKeys(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  // The server resolves secret refs into config.env before calling testEnvironment,
  // so we check config.env first (adapter-configured secrets), then fall back to
  // process.env (server/host environment). This mirrors how the Claude adapter does it.
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }

  const has = (key: string): boolean =>
    !!(resolvedEnv[key] ?? process.env[key]);

  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");
  const hasKimi = has("KIMI_API_KEY");
  const hasMiniMax = has("MINIMAX_API_KEY");

  if (!hasAnthropic && !hasOpenRouter && !hasOpenAI && !hasZai && !hasKimi && !hasMiniMax) {
    return {
      level: "warn",
      message: "No LLM API keys found in environment",
      hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
      code: "hermes_no_api_keys",
    };
  }

  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");
  if (hasKimi) providers.push("Kimi");
  if (hasMiniMax) providers.push("MiniMax");

  return {
    level: "info",
    message: `API keys found: ${providers.join(", ")}`,
    code: "hermes_api_keys_found",
  };
}

/**
 * Check provider/model consistency.
 * Warns if the configured provider might be wrong for the model.
 */
async function checkProviderConsistency(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck | null> {
  const model = asString(config.model);
  if (!model) return null;

  const explicitProvider = asString(config.provider);

  // Try to detect from Hermes config
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  try {
    detectedConfig = await detectModel();
  } catch {
    // Non-fatal
  }

  const { provider: resolved, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });

  // If provider was explicitly set but doesn't match what Hermes config says,
  // that's worth flagging.
  if (explicitProvider && detectedConfig?.provider && explicitProvider !== detectedConfig.provider) {
    return {
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${explicitProvider}" but ~/.hermes/config.yaml has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${explicitProvider}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    };
  }

  // If provider was auto-detected (not explicitly set), log what was resolved
  if (!explicitProvider && resolvedFrom !== "auto") {
    return {
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    };
  }

  // If we couldn't resolve any provider, warn
  if (resolvedFrom === "auto" && !explicitProvider) {
    return {
      level: "warn",
      message: `Could not determine provider for model "${model}" — will use Hermes auto-detection`,
      hint: "Set an explicit provider in the agent config or ensure ~/.hermes/config.yaml has a matching provider for this model.",
      code: "hermes_provider_unknown",
    };
  }

  return null;
}

function checkCwd(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const cwd = asString(config.cwd);
  if (!cwd) {
    return {
      level: "info",
      message: "No CWD configured — Hermes will use the process working directory",
      code: "hermes_cwd_default",
    };
  }
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return {
        level: "error",
        message: `Configured CWD "${cwd}" exists but is not a directory`,
        hint: "Set cwd to a valid directory path in the agent configuration",
        code: "hermes_cwd_invalid",
      };
    }
    return {
      level: "info",
      message: `CWD "${cwd}" exists and is a directory`,
      code: "hermes_cwd_valid",
    };
  } catch {
    return {
      level: "error",
      message: `Configured CWD "${cwd}" does not exist`,
      hint: "Create the directory or update cwd in the agent configuration",
      code: "hermes_cwd_invalid",
    };
  }
}

async function checkHelloProbe(
  command: string,
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck> {
  // Collect any -p/--profile args from extraArgs to pass along
  const extraArgs = Array.isArray(config.extraArgs)
    ? (config.extraArgs as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const profileArgs: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "-p" || extraArgs[i] === "--profile") {
      profileArgs.push(extraArgs[i]);
      if (i + 1 < extraArgs.length) {
        profileArgs.push(extraArgs[++i]);
      }
    } else if (extraArgs[i].startsWith("--profile=")) {
      profileArgs.push(extraArgs[i]);
    }
  }

  const args = ["chat", "-q", "Respond with hello.", "-Q", ...profileArgs];

  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 45_000 });
    const output = stdout.trim().toLowerCase();
    if (output.includes("hello")) {
      return {
        level: "info",
        message: "Live hello probe passed — Hermes responded correctly",
        code: "hermes_hello_probe_passed",
      };
    }
    return {
      level: "warn",
      message: `Live hello probe returned unexpected output: "${stdout.trim().slice(0, 120)}"`,
      hint: "Hermes is reachable but the response did not contain 'hello'. Check model and provider configuration.",
      code: "hermes_hello_probe_unexpected_output",
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (e.killed || e.signal === "SIGTERM" || (e.message && e.message.includes("timed out"))) {
      return {
        level: "warn",
        message: "Live hello probe timed out after 45 seconds",
        hint: "Hermes may be slow to respond or the network/API is unreachable",
        code: "hermes_hello_probe_timed_out",
      };
    }
    return {
      level: "warn",
      message: `Live hello probe failed: ${e.message ?? String(err)}`,
      hint: "Check that Hermes Agent is correctly installed, API keys are set, and the model is accessible",
      code: "hermes_hello_probe_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = asString(config.hermesCommand) || HERMES_CLI;
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. CLI installed?
  const cliCheck = await checkCliInstalled(command);
  if (cliCheck) {
    checks.push(cliCheck);
    if (cliCheck.level === "error") {
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  // 2. CLI version
  const versionCheck = await checkCliVersion(command);
  if (versionCheck) checks.push(versionCheck);

  // 3. Python available?
  const pythonCheck = await checkPython();
  if (pythonCheck) checks.push(pythonCheck);

  // 4. Model config
  const modelCheck = checkModel(config);
  if (modelCheck) checks.push(modelCheck);

  // 5. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = checkApiKeys(config);
  if (apiKeyCheck) checks.push(apiKeyCheck);

  // 6. CWD validation
  const cwdCheck = checkCwd(config);
  if (cwdCheck) checks.push(cwdCheck);

  // 7. Provider/model consistency
  const providerCheck = await checkProviderConsistency(config);
  if (providerCheck) checks.push(providerCheck);

  // 8. Live hello probe
  const helloProbeCheck = await checkHelloProbe(command, config);
  checks.push(helloProbeCheck);

  // Determine overall status
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
