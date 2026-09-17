// BOO-456 AC5 verification: banner-only resumed-run detection.
// Imports the built isBannerOnlyRun from dist/server/execute.js.
import { isBannerOnlyRun } from "../dist/server/execute.js";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, want ${expected})`);
}

// ── Sample 1: synthetic banner-only resumed run (the BOO-454 fingerprint) ──
// A stale resumed session prints the startup banner, makes zero tool calls,
// and produces no substantive response.
const bannerOnlyStdout = `Hermes Agent v4.12.0
Model: deepseek-v4-flash (provider: deepseek)
Available Tools: terminal, file, search, web, memory, skills, process, patch
Available Skills: software-development, devops, paperclip-adapter, domain
Session source: tool
Type a message or use a tool to get started.`;
check("synthetic banner-only stdout + empty response → drop", isBannerOnlyRun(bannerOnlyStdout, ""), true);

// Banner-only where the parsed response IS the banner text (comment posted banner).
check("banner text as response → drop", isBannerOnlyRun(bannerOnlyStdout, bannerOnlyStdout), true);

// ── Sample 2: productive resumed run with tool calls ──
const productiveStdout = `┊ 💬 I'll check the issue details first.
┊ 🔍 search    pattern: BOO-456 in /home/hermes/hermes-paperclip-adapter  0.4s
┊ 💻 $         curl -s http://127.0.0.1:3100/api/issues/xyz  1.2s
┊ 💬 Found the issue. Implementing the fix now.
session_id: abc123`;
check("productive resumed run (quiet-mode tool lines) → keep", isBannerOnlyRun(productiveStdout, "Found the issue. Implementing the fix now."), false);

// ── Sample 3: non-quiet tool markers ──
const nonQuietStdout = `[tool] 🔍 search BOO-456
[done] ┊ 🔍 search    BOO-456 in src  0.3s (0.4s)
Hermes Agent v4.12.0
Available Tools: terminal, file`;
check("non-quiet [tool]/[done]┊ markers → keep", isBannerOnlyRun(nonQuietStdout, "Did the work."), false);

// ── Sample 4: substantive response, no tools ──
check("substantive response without tools → keep", isBannerOnlyRun("", "Done: implemented the fix in execute.ts."), false);

// ── Sample 5: empty output, no tools (degenerate resumed run) → drop ──
check("empty stdout + empty response → drop", isBannerOnlyRun("", ""), true);

// ── Sample 6: banner + tool activity mixed → keep ──
const bannerWithTools = `Hermes Agent v4.12.0
Available Tools: terminal, file
┊ 💻 $         ls -la  0.1s
┊ 💬 Did the work.`;
check("banner text + real tool call → keep", isBannerOnlyRun(bannerWithTools, "Did the work."), false);

// ── Sample 7: assistant-only quiet line (┊ 💬) must NOT count as tool activity ──
const assistantOnly = `┊ 💬 I'm the Hermes Agent. How can I help?`;
check("assistant-only ┊ 💬 line + banner response → drop", isBannerOnlyRun(assistantOnly, "Hermes Agent v4.12.0\nAvailable Tools: terminal, file"), true);

// ── Sample 8: REAL evidence from BOO-455 (the banner-only comment the stale ──
// ── Counsel session posted on 2026-08-09 12:27:59Z, re-fired on BOO-451) ──
import { readFileSync } from "node:fs";
const realBanner = readFileSync(
  new URL("./real-banner-sample.txt", import.meta.url),
  "utf8",
);
check("REAL BOO-451 stale banner (raw stdout) + empty response → drop", isBannerOnlyRun(realBanner, ""), true);
check("REAL BOO-451 stale banner as the parsed response → drop", isBannerOnlyRun(realBanner, realBanner), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
