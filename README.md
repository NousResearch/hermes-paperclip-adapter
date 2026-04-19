# Paperclip Adapter for Hermes Agent

A [Paperclip](https://paperclip.ing) adapter that lets you run [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

Hermes Agent is a full-featured AI agent by [Nous Research](https://nousresearch.com) with 30+ native tools, persistent memory, session persistence, 80+ skills, MCP support, and multi-provider model access.

## Key Features

This adapter provides:

- **8 inference providers** — Anthropic, OpenRouter, OpenAI, Nous, OpenAI Codex, ZAI, Kimi Coding, MiniMax
- **Skills integration** — Scans both Paperclip-managed and Hermes-native skills (`~/.hermes/skills/`), with sync/list/resolve APIs
- **Structured transcript parsing** — Raw Hermes stdout is parsed into typed `TranscriptEntry` objects so Paperclip renders proper tool cards with status icons and expand/collapse
- **Rich post-processing** — Converts Hermes ASCII banners, setext headings, and `+--+` table borders into clean GFM markdown
- **Comment-driven wakes** — Agents wake to respond to issue comments, not just task assignments
- **Auto model detection** — Reads `~/.hermes/config.yaml` to pre-populate the UI with the user's configured model
- **Session codec** — Structured validation and migration of session state across heartbeats
- **Benign stderr reclassification** — MCP init messages and structured logs are reclassified so they don't appear as errors in the UI
- **Session source tagging** — Sessions are tagged as `tool` source so they don't clutter the user's interactive history
- **Filesystem checkpoints** — Optional `--checkpoints` for rollback safety
- **Thinking effort control** — Passes `--reasoning-effort` for thinking/reasoning models
- **3-tier model fallback** — Transparent resilience: MiniMax plan key → MiniMax PAYG → Kimi K2.5 via OpenRouter. Automatic swap on HTTP 429 or provider outage. Daily spend limits protect runaway costs.

### Hermes Agent Capabilities

| Feature | Claude Code | Codex | Hermes Agent |
|---------|------------|-------|-------------|
| Persistent memory | ❌ | ❌ | ✅ Remembers across sessions |
| Native tools | ~5 | ~5 | 30+ (terminal, file, web, browser, vision, git, etc.) |
| Skills system | ❌ | ❌ | ✅ 80+ loadable skills |
| Session search | ❌ | ❌ | ✅ FTS5 search over past conversations |
| Sub-agent delegation | ❌ | ❌ | ✅ Parallel sub-tasks |
| Context compression | ❌ | ❌ | ✅ Auto-compresses long conversations |
| MCP client | ❌ | ❌ | ✅ Connect to any MCP server |
| Multi-provider | Anthropic only | OpenAI only | ✅ 8 providers out of the box |

## Installation

```bash
npm install hermes-paperclip-adapter
```

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed (`pip install hermes-agent`)
- Python 3.10+
- At least one LLM API key (Anthropic, OpenRouter, or OpenAI)

## Quick Start

### 1. Register the adapter in your Paperclip server

Add to your Paperclip server's adapter registry (`server/src/adapters/registry.ts`):

```typescript
import * as hermesLocal from "hermes-paperclip-adapter";
import {
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
} from "hermes-paperclip-adapter/server";

registry.set("hermes_local", {
  ...hermesLocal,
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
});
```

### 2. Create a Hermes agent in Paperclip

In the Paperclip UI or via API, create an agent with adapter type `hermes_local`:

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "maxIterations": 50,
    "timeoutSec": 300,
    "persistSession": true,
    "enabledToolsets": ["terminal", "file", "web"]
  }
}
```

### 3. Assign work

Create issues in Paperclip and assign them to your Hermes agent. On each heartbeat, Hermes will:

1. Receive the task instructions
2. Use its full tool suite to complete the work
3. Report results back to Paperclip
4. Persist session state for continuity

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `anthropic/claude-sonnet-4` | Model in `provider/model` format |
| `provider` | string | *(auto-detected)* | API provider: `auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, `minimax-cn` |
| `timeoutSec` | number | `300` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated toolsets to enable (e.g. `"terminal,file,web"`) |

Available toolsets: `terminal`, `file`, `web`, `browser`, `code_execution`, `vision`, `mcp`, `creative`, `productivity`

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistSession` | boolean | `true` | Resume sessions across heartbeats |
| `worktreeMode` | boolean | `false` | Git worktree isolation |
| `checkpoints` | boolean | `false` | Enable filesystem checkpoints for rollback |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Enable verbose output |
| `quiet` | boolean | `true` | Quiet mode (clean output, no banner/spinner) |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom prompt template |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API base URL |

### Prompt Template Variables

Use `{{variable}}` syntax in `promptTemplate`:

| Variable | Description |
|----------|-------------|
| `{{agentId}}` | Paperclip agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | Company ID |
| `{{companyName}}` | Company name |
| `{{runId}}` | Current heartbeat run ID |
| `{{taskId}}` | Assigned task/issue ID |
| `{{taskTitle}}` | Task title |
| `{{taskBody}}` | Task instructions |
| `{{projectName}}` | Project name |
| `{{paperclipApiUrl}}` | Paperclip API base URL |
| `{{commentId}}` | Comment ID (when woken by a comment) |
| `{{wakeReason}}` | Reason this run was triggered |

Conditional sections:

- `{{#taskId}}...{{/taskId}}` — included only when a task is assigned
- `{{#noTask}}...{{/noTask}}` — included only when no task (heartbeat check)
- `{{#commentId}}...{{/commentId}}` — included only when woken by a comment

## Architecture

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  Heartbeat       │               │                  │
│  Scheduler       │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue System    │               │  30+ Tools       │
│  Comment Wakes   │◀──results─────│  Memory System   │
│                  │               │  Session DB      │
│  Cost Tracking   │               │  Skills          │
│                  │               │  MCP Client      │
│  Skill Sync      │◀──snapshot────│  ~/.hermes/skills│
│  Org Chart       │               │                  │
└──────────────────┘               └──────────────────┘
```

The adapter spawns Hermes Agent's CLI in single-query mode (`-q`). Hermes
processes the task using its full tool suite, then exits. The adapter:

1. **Captures** stdout/stderr and parses token usage, session IDs, and cost
2. **Parses** raw output into structured `TranscriptEntry` objects (tool cards with status icons)
3. **Post-processes** Hermes ASCII formatting (banners, setext headings, table borders) into clean GFM markdown
4. **Reclassifies** benign stderr (MCP init, structured logs) so they don't show as errors
5. **Tags** sessions as `tool` source to keep them separate from interactive usage
6. **Reports** results back to Paperclip with cost, usage, and session state

Session persistence works via Hermes's `--resume` flag — each run picks
up where the last one left off, maintaining conversation context,
memories, and tool state across heartbeats. The `sessionCodec` validates
and migrates session state between runs.

### Skills Integration

The adapter scans two skill sources and merges them:

- **Paperclip-managed skills** — bundled with the adapter, togglable from the UI
- **Hermes-native skills** — from `~/.hermes/skills/`, read-only, always loaded

The `listSkills` / `syncSkills` APIs expose a unified snapshot so the
Paperclip UI can display both managed and native skills in one view.

## 3-Tier Model Fallback

The adapter implements automatic 3-tier model fallback for resilience against rate limits and provider outages. This is transparent to the agent — it sees only one model, but the adapter swaps tiers automatically when needed.

### Tier Chain

| Tier | Trigger | Model | Provider | Billing | Daily Budget |
|------|---------|-------|----------|---------|--------------|
| 1 (primary) | Normal operation | MiniMax-M2.7 | minimax | MiniMax plan key (10 USD/mo flat) | None (flat plan) |
| 2 (cap overflow) | Tier 1 returns HTTP 429 or 5xx | MiniMax-M2.7 | minimax | MiniMax PAYG key (~0.05 USD/run) | 5 USD/day |
| 3 (provider outage) | Tier 2 also fails or MiniMax is down | moonshotai/kimi-k2.5 | kimi-coding | OpenRouter (~0.10 USD/run) | 5 USD/day |

### Fallback Triggers

Fallback is triggered by these patterns in the Hermes output:
- HTTP 429 (rate limit / plan cap exceeded)
- HTTP 5xx (provider server error)
- "rate limit", "cap exceeded", "quota exceeded", "too many requests"
- "provider is down", "connection refused/reset/timeout"

### Required Keys

For full 3-tier resilience, set these in `~/.hermes/.env`:

```bash
MINIMAX_API_KEY=<your MiniMax plan key>       # Tier 1
MINIMAX_PAYG_KEY=<your MiniMax PAYG key>      # Tier 2 (plan-cap overflow)
OPENROUTER_API_KEY=<your OpenRouter key>      # Tier 3 (provider outage)
```

If `MINIMAX_PAYG_KEY` is not set, tier 2 is skipped. If `OPENROUTER_API_KEY` is not set, tier 3 is skipped. Without any keys, only tier 1 runs.

### Cost Controls

Tier 2 and tier 3 have a configurable daily spend limit (default 5 USD/day). The counter resets when the Paperclip server restarts. For long-running servers, consider a cron job to alert on spend.

### Concurrency

The 3-tier fallback is not a substitute for concurrency control. The Paperclip concurrency throttle still gates maximum concurrent sessions. Fallback only handles rate-limit and outage scenarios within the allowed concurrency window.

### Tier Selection and Budget Checking

On each run, the adapter iterates tiers in order. Tiers with exhausted daily budgets are skipped silently until the server restarts (which resets the in-process counter). If all tiers are over budget, execution fails with a clear error message.

### Fallback Logging

Each tier attempt is logged:
```
[hermes] [Tier 1/3] MiniMax Plan (primary) — model=MiniMax-M2.7, provider=minimax
[hermes] [Tier 1] Exit code: 0, timed out: false
[hermes] [Tier 1] FALLBACK triggered: rate-limit or 5xx detected. Trying next tier.
[hermes] [Tier 2/3] MiniMax PAYG (cap overflow) — model=MiniMax-M2.7, provider=minimax
...
```

### Testing the Fallback Chain

To verify the fallback chain works correctly, you can test tier transitions manually:

**Test 1 — Tier 1 → Tier 2 (rate-limit overflow)**

Simulate a tier-1 rate limit by temporarily setting a bad `MINIMAX_API_KEY`:

```bash
# Set tier-1 key to a bad value so it hits 429
MINIMAX_API_KEY="bad-key-for-testing" \
MINIMAX_PAYG_KEY="<real PAYG key>" \
hermes chat -q "Say hello" --provider minimax -m MiniMax-M2.7
# Expected: falls back to tier 2 using MINIMAX_PAYG_KEY
```

**Test 2 — Tier 2 → Tier 3 (provider outage)**

Simulate tier-2 failure by also providing a bad PAYG key:

```bash
MINIMAX_API_KEY="bad-key" \
MINIMAX_PAYG_KEY="also-bad" \
OPENROUTER_API_KEY="<real OpenRouter key>" \
hermes chat -q "Say hello" --provider kimi-coding -m moonshotai/kimi-k2.5
# Expected: tier 3 uses Kimi K2.5 via OpenRouter
```

**Test 3 — All tiers exhausted**

With all keys bad, verify the adapter returns a clear error:

```
[hermes] FATAL: All 3 tiers exhausted.
```

**Programmatic test via the adapter's `execute()` API:**

```typescript
import { execute } from 'hermes-paperclip-adapter/server';

// Force tier-1 to fail by mocking the error detection
const result = await execute({
  agent: { id: 'test-agent', companyId: 'test-company' },
  config: {
    hermesCommand: 'hermes',
    timeoutSec: 60,
    // Pass bad tier-1 key via env — the adapter will fallback
    env: { MINIMAX_API_KEY: 'force-tier1-fail' },
  } as any,
  onLog: console.log,
});

// result.provider / result.model will reflect which tier succeeded
console.log(result.provider, result.model);
```

**Manual verification of error pattern detection:**

The fallback triggers on these regex patterns (defined in `FALLBACK_ERROR_PATTERNS`):

| Pattern | Trigger |
|---------|---------|
| `/429\\s+(?:rate\\s*limit\|limit exceeded)/i` | HTTP 429 rate limit |
| `/rate\\s*limit/i` | Any "rate limit" in output |
| `/cap(?:\\s+exceeded\|\\s+reached)/i` | Plan cap exceeded |
| `/500.*internal/i` | MiniMax 500 error |
| `/503.*Service Unavailable/i` | MiniMax 503 error |
| `/provider\\s+down/i` | Provider down message |

Test each by grepping the combined stdout+stderr of a failed run.

## Development

```bash
git clone https://github.com/NousResearch/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm run build
```

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — The AI agent this adapter runs
- [Paperclip](https://github.com/paperclipai/paperclip) — The orchestration platform
- [Nous Research](https://nousresearch.com) — The team behind Hermes
- [Paperclip Docs](https://paperclip.ing/docs) — Paperclip documentation
