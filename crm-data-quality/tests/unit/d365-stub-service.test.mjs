import test from "node:test";
import assert from "node:assert/strict";
import { extractSnapshots, scoreSnapshots, publishResults } from "../../stubs/d365-stub-service.mjs";

test("extract returns deterministic snapshots for supported entities", () => {
  const result = extractSnapshots({
    source_env: "dev",
    correlation_id: "corr-2026-05-14-001",
    entity_logical_names: ["account", "contact"]
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.scan_run.scan_run_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(result.data.snapshots.length, 2);
  assert.match(result.data.snapshots[0].ingest_hash, /^[a-f0-9]{64}$/i);
});

test("score returns deterministic summary and rule outputs", () => {
  const result = scoreSnapshots({
    scan_run_id: "11111111-1111-1111-1111-111111111111",
    contract_version: "v1.0"
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.score_summary.overall_score, 92);
  assert.equal(result.data.rule_results.length, 2);
});

test("publish validates attempt count", () => {
  const bad = publishResults({
    scan_run_id: "11111111-1111-1111-1111-111111111111",
    destination: "dataverse",
    attempt_count: 0
  });

  assert.equal(bad.ok, false);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.error.error_code, "publish_invalid_attempt_count");
});
