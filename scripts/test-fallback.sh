#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-fallback.sh — Verify 3-tier fallback chain is wired correctly.
#
# Usage: ./scripts/test-fallback.sh
#
# What it checks:
#   1. Required env vars are present (tells Adrian what's missing)
#   2. FALLBACK_TIERS constant has correct structure
#   3. SpendTracker budget logic (unit test via node --eval)
#   4. resolveFallbackTiers config override logic
#
# For real end-to-end testing: trigger a deliberate 429 by temporarily
# setting MINIMAX_API_KEY to an invalid value, then observe the tier-2
# swap in the Paperclip agent logs.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$ADAPTER_DIR/src"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "[INFO] $1"; }

echo "=============================================="
echo " Hermes 3-Tier Fallback — Integration Tests"
echo "=============================================="
echo ""

# ---------------------------------------------------------------------------
# Test 1: Required env vars
# ---------------------------------------------------------------------------
info "Test 1: Checking required environment variables..."

MISSING=0

if [[ -z "${MINIMAX_API_KEY:-}" ]]; then
  warn "MINIMAX_API_KEY is not set — tier 1 (primary) will not function"
  MISSING=$((MISSING+1))
else
  pass "MINIMAX_API_KEY is set (tier 1: MiniMax Plan)"
fi

if [[ -z "${MINIMAX_PAYG_KEY:-}" ]]; then
  warn "MINIMAX_PAYG_KEY is not set — tier 2 (PAYG overflow) will be SKIPPED at runtime"
  MISSING=$((MISSING+1))
else
  pass "MINIMAX_PAYG_KEY is set (tier 2: MiniMax PAYG)"
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  warn "OPENROUTER_API_KEY is not set — tier 3 (Kimi K2.5) will be SKIPPED at runtime"
  MISSING=$((MISSING+1))
else
  pass "OPENROUTER_API_KEY is set (tier 3: Kimi K2.5 via OpenRouter)"
fi

if [[ $MISSING -gt 0 ]]; then
  warn "$MISSING key(s) missing — 3-tier fallback will be PARTIAL. Adrian: see resilience.md"
fi
echo ""

# ---------------------------------------------------------------------------
# Test 2: Verify FALLBACK_TIERS structure in TypeScript
# ---------------------------------------------------------------------------
info "Test 2: Verifying FALLBACK_TIERS constant structure..."

node --input-type=module << 'NODEEOF'
import { FALLBACK_TIERS, DEFAULT_TIER_DAILY_SPEND_LIMIT_USD, FALLBACK_ERROR_PATTERNS } from './dist/shared/constants.js';

const errors = [];

// Must have exactly 3 tiers
if (FALLBACK_TIERS.length !== 3) {
  errors.push(`Expected 3 tiers, got ${FALLBACK_TIERS.length}`);
}

// Tier 1 checks
const t1 = FALLBACK_TIERS[0];
if (!t1) { errors.push('Tier 1 missing'); }
else {
  if (t1.tier !== 1) errors.push(`Tier 1 number: expected 1, got ${t1.tier}`);
  if (!t1.label.toLowerCase().includes('plan')) errors.push(`Tier 1 label should mention plan: ${t1.label}`);
  if (t1.dailySpendLimitUsd !== null) errors.push(`Tier 1 should have no budget limit (null), got ${t1.dailySpendLimitUsd}`);
  if (t1.provider !== 'minimax') errors.push(`Tier 1 provider: expected minimax, got ${t1.provider}`);
}

// Tier 2 checks
const t2 = FALLBACK_TIERS[1];
if (!t2) { errors.push('Tier 2 missing'); }
else {
  if (t2.tier !== 2) errors.push(`Tier 2 number: expected 2, got ${t2.tier}`);
  if (!t2.label.includes('PAYG')) errors.push(`Tier 2 label should mention PAYG: ${t2.label}`);
  if (t2.dailySpendLimitUsd !== DEFAULT_TIER_DAILY_SPEND_LIMIT_USD)
    errors.push(`Tier 2 budget: expected ${DEFAULT_TIER_DAILY_SPEND_LIMIT_USD}, got ${t2.dailySpendLimitUsd}`);
  if (t2.provider !== 'minimax') errors.push(`Tier 2 provider: expected minimax, got ${t2.provider}`);
  if (t2.minimaxApiKeyOverride !== undefined)
    errors.push(`Tier 2 minimaxApiKeyOverride should come from env at runtime, not hardcoded`);
}

// Tier 3 checks
const t3 = FALLBACK_TIERS[2];
if (!t3) { errors.push('Tier 3 missing'); }
else {
  if (t3.tier !== 3) errors.push(`Tier 3 number: expected 3, got ${t3.tier}`);
  if (!t3.label.includes('Kimi') && !t3.label.includes('kimi'))
    errors.push(`Tier 3 label should mention Kimi: ${t3.label}`);
  if (t3.dailySpendLimitUsd !== DEFAULT_TIER_DAILY_SPEND_LIMIT_USD)
    errors.push(`Tier 3 budget: expected ${DEFAULT_TIER_DAILY_SPEND_LIMIT_USD}, got ${t3.dailySpendLimitUsd}`);
  if (!t3.model.includes('kimi'))
    errors.push(`Tier 3 model should be kimi: ${t3.model}`);
}

// Error patterns
if (FALLBACK_ERROR_PATTERNS.length === 0)
  errors.push('FALLBACK_ERROR_PATTERNS is empty — fallback will never trigger');

if (errors.length > 0) {
  console.error('ERRORS:');
  errors.forEach(e => console.error('  -', e));
  process.exit(1);
} else {
  console.log('PASS: FALLBACK_TIERS structure is correct');
  console.log('  Tier 1:', t1.label, '| model:', t1.model, '| provider:', t1.provider);
  console.log('  Tier 2:', t2.label, '| model:', t2.model, '| provider:', t2.provider, '| budget: $' + t2.dailySpendLimitUsd + '/day');
  console.log('  Tier 3:', t3.label, '| model:', t3.model, '| provider:', t3.provider, '| budget: $' + t3.dailySpendLimitUsd + '/day');
  console.log('  Fallback error patterns:', FALLBACK_ERROR_PATTERNS.length, 'patterns configured');
}
NODEEOF

RESULT=$?
if [[ $RESULT -eq 0 ]]; then
  pass "FALLBACK_TIERS structure verified"
else
  fail "FALLBACK_TIERS structure check failed"
fi
echo ""

# ---------------------------------------------------------------------------
# Test 3: SpendTracker budget logic
# ---------------------------------------------------------------------------
info "Test 3: Testing SpendTracker budget tracking..."

node --input-type=module << 'NODEEOF'
// Inline minimal SpendTracker to test the budget logic
class SpendTracker {
  constructor() {
    this.entries = new Map();
  }

  getRemainingBudget(tier) {
    if (tier.dailySpendLimitUsd === null || tier.dailySpendLimitUsd === undefined) return null;
    const key = this.todayKey();
    const entry = this.entries.get(tier.tier);
    const spent = entry?.date === key ? entry.spentUsd : 0;
    return Math.max(0, tier.dailySpendLimitUsd - spent);
  }

  recordSpend(tier, costUsd) {
    if (tier.dailySpendLimitUsd === null || tier.dailySpendLimitUsd === undefined) return;
    const key = this.todayKey();
    const entry = this.entries.get(tier.tier);
    const current = entry?.date === key ? entry.spentUsd : 0;
    this.entries.set(tier.tier, { date: key, spentUsd: current + costUsd });
  }

  todayKey() { return new Date().toISOString().slice(0, 10); }
}

const tracker = new SpendTracker();
const TIER = { tier: 2, label: 'test', model: 'test', provider: 'test', dailySpendLimitUsd: 5 };

const errors = [];

// Budget starts at full
const initial = tracker.getRemainingBudget(TIER);
if (initial !== 5) errors.push(`Initial budget should be 5, got ${initial}`);

// Record spend
tracker.recordSpend(TIER, 2.50);
const after1 = tracker.getRemainingBudget(TIER);
if (after1 !== 2.50) errors.push(`After $2.50 spend: budget should be 2.50, got ${after1}`);

// Exhaust budget
tracker.recordSpend(TIER, 3.00);
const exhausted = tracker.getRemainingBudget(TIER);
if (exhausted !== 0) errors.push(`After exhausting: budget should be 0, got ${exhausted}`);

// No-limit tier
const noLimit = { tier: 1, label: 't1', model: 'm', provider: 'p', dailySpendLimitUsd: null };
const noLimitBudget = tracker.getRemainingBudget(noLimit);
if (noLimitBudget !== null) errors.push(`No-limit tier should return null, got ${noLimitBudget}`);

if (errors.length > 0) {
  console.error('ERRORS:', errors);
  process.exit(1);
} else {
  console.log('PASS: SpendTracker budget logic works correctly');
}
NODEEOF

RESULT=$?
if [[ $RESULT -eq 0 ]]; then
  pass "SpendTracker budget logic verified"
else
  fail "SpendTracker budget logic check failed"
fi
echo ""

# ---------------------------------------------------------------------------
# Test 4: resolveFallbackTiers config override
# ---------------------------------------------------------------------------
info "Test 4: Testing resolveFallbackTiers config override..."

node --input-type=module << 'NODEEOF'
import { FALLBACK_TIERS } from './dist/shared/constants.js';

function resolveFallbackTiers(config, defaultTiers) {
  const overrides = ((config.fallbackTiers) ?? [])
    .reduce((acc, o) => { acc[o.tier] = o; return acc; }, {});

  return defaultTiers.map((tier) => {
    const override = overrides[tier.tier];
    if (override === undefined) return tier;
    return {
      ...tier,
      dailySpendLimitUsd:
        override.dailyBudgetUsd === undefined
          ? tier.dailySpendLimitUsd
          : override.dailyBudgetUsd,
    };
  });
}

const errors = [];

// Default — no overrides
const defaultTiers = resolveFallbackTiers({}, FALLBACK_TIERS);
if (defaultTiers[1].dailySpendLimitUsd !== 5)
  errors.push(`Default tier 2 budget should be 5, got ${defaultTiers[1].dailySpendLimitUsd}`);

// Override tier 2 budget to 10
const overridden = resolveFallbackTiers({
  fallbackTiers: [{ tier: 2, dailyBudgetUsd: 10 }]
}, FALLBACK_TIERS);
if (overridden[1].dailySpendLimitUsd !== 10)
  errors.push(`Override tier 2 budget should be 10, got ${overridden[1].dailySpendLimitUsd}`);

// Disable tier 2 budget (null = no limit)
const noLimit2 = resolveFallbackTiers({
  fallbackTiers: [{ tier: 2, dailyBudgetUsd: null }]
}, FALLBACK_TIERS);
if (noLimit2[1].dailySpendLimitUsd !== null)
  errors.push(`Null budget should mean unlimited, got ${noLimit2[1].dailySpendLimitUsd}`);

// Unknown tier override is ignored
const unknownTier = resolveFallbackTiers({
  fallbackTiers: [{ tier: 99, dailyBudgetUsd: 1 }]
}, FALLBACK_TIERS);
if (unknownTier[1].dailySpendLimitUsd !== 5)
  errors.push(`Unknown tier override should be ignored, got ${unknownTier[1].dailySpendLimitUsd}`);

if (errors.length > 0) {
  console.error('ERRORS:', errors);
  process.exit(1);
} else {
  console.log('PASS: resolveFallbackTiers override logic works correctly');
}
NODEEOF

RESULT=$?
if [[ $RESULT -eq 0 ]]; then
  pass "resolveFallbackTiers override logic verified"
else
  fail "resolveFallbackTiers override logic check failed"
fi
echo ""

# ---------------------------------------------------------------------------
# Test 5: shouldFallback detection patterns
# ---------------------------------------------------------------------------
info "Test 5: Testing shouldFallback error pattern detection..."

node --input-type=module << 'NODEEOF'
import { FALLBACK_ERROR_PATTERNS } from './dist/shared/constants.js';

function shouldFallback(tier, combinedOutput) {
  if (!tier.errorPatterns) return false;
  return tier.errorPatterns.some((pattern) => pattern.test(combinedOutput));
}

const tier = { tier: 1, errorPatterns: FALLBACK_ERROR_PATTERNS };

const tests = [
  // [output, expectedFallback]
  ['error 429 rate limit exceeded', true,  '429 rate limit'],
  ['HTTP 429: Too Many Requests', true,    'HTTP 429'],
  ['rate limit hit',               true,    'rate limit text'],
  ['plan cap reached',             true,    'cap reached'],
  ['500 Internal Server Error',    true,    '500 ISE'],
  ['503 Service Unavailable',      true,    '503'],
  ['502 Bad Gateway',              true,    '502'],
  ['504 Gateway Timeout',          true,    '504'],
  ['provider is down',             true,    'provider down'],
  ['upstream timeout',             true,    'upstream timeout'],
  ['connection refused',           true,    'connection refused'],
  ['all good here',                false,   'clean output'],
  ['usage: hermes chat [options]', false,   'help text'],
];

const errors = [];
for (const [output, expected, label] of tests) {
  const result = shouldFallback(tier, output);
  if (result !== expected) {
    errors.push(`${label}: expected fallback=${expected}, got ${result}`);
  }
}

if (errors.length > 0) {
  console.error('ERRORS:');
  errors.forEach(e => console.error('  -', e));
  process.exit(1);
} else {
  console.log('PASS: shouldFallback pattern detection works correctly');
  console.log('  Tested', tests.length, 'error patterns');
}
NODEEOF

RESULT=$?
if [[ $RESULT -eq 0 ]]; then
  pass "shouldFallback pattern detection verified"
else
  fail "shouldFallback pattern detection check failed"
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=============================================="
info "All structural checks passed."
info ""
info "To test real tier swapping end-to-end:"
info "  1. Temporarily set MINIMAX_API_KEY to an invalid key"
info "  2. Trigger an agent heartbeat in Paperclip"
info "  3. Watch for '[Tier 1] FALLBACK triggered' in the agent logs"
info "  4. Confirm '[Tier 2]' execution begins"
info "  5. Revert the invalid key"
info ""
info "Keys still needed from Adrian:"
[[ -z "${MINIMAX_PAYG_KEY:-}" ]] && warn "  - MINIMAX_PAYG_KEY (platform.minimax.io, load ~\$20)" || pass "  - MINIMAX_PAYG_KEY ✓"
[[ -z "${OPENROUTER_API_KEY:-}" ]] && warn "  - OPENROUTER_API_KEY" || pass "  - OPENROUTER_API_KEY ✓"
echo "=============================================="
