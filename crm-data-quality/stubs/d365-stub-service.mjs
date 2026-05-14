const CONTRACT_VERSION = "v1.0";
const SOURCE_SYSTEM = "dataverse";

const FIXED_IDS = {
  scanRunId: "11111111-1111-1111-1111-111111111111",
  snapshotAccountId: "22222222-2222-2222-2222-222222222222",
  snapshotContactId: "33333333-3333-3333-3333-333333333333",
  scoreSummaryId: "44444444-4444-4444-4444-444444444444",
  ruleResultPassId: "55555555-5555-5555-5555-555555555555",
  ruleResultWarnId: "66666666-6666-6666-6666-666666666666",
  publishEventId: "77777777-7777-7777-7777-777777777777"
};

const FIXED_TIMESTAMPS = {
  startedAt: "2026-05-14T12:00:00Z",
  completedAt: "2026-05-14T12:03:00Z",
  evaluatedAt: "2026-05-14T12:01:30Z",
  publishedAt: "2026-05-14T12:03:00Z"
};

function makeHash(seed) {
  return seed.repeat(64).slice(0, 64);
}

export function extractSnapshots(request) {
  if (!request?.source_env?.trim()) {
    return error("extract_invalid_source_env", "source_env is required");
  }

  const supported = new Set(["account", "contact", "lead", "opportunity"]);
  const entities = request.entity_logical_names ?? [];
  if (!Array.isArray(entities) || entities.length === 0 || entities.some((entity) => !supported.has(entity))) {
    return error("extract_invalid_entities", "entity_logical_names must contain only supported entities");
  }

  const snapshots = [
    {
      snapshot_id: FIXED_IDS.snapshotAccountId,
      scan_run_id: FIXED_IDS.scanRunId,
      entity_logical_name: "account",
      entity_primary_id: "acc-1001",
      entity_primary_name: "Apex Wholesale",
      region_code: "US-CENTRAL",
      owner_principal_id: "88888888-8888-8888-8888-888888888888",
      modified_on_utc: "2026-05-13T19:10:00Z",
      ingest_hash: makeHash("a"),
      pii_policy_tag: "none"
    },
    {
      snapshot_id: FIXED_IDS.snapshotContactId,
      scan_run_id: FIXED_IDS.scanRunId,
      entity_logical_name: "contact",
      entity_primary_id: "con-2033",
      entity_primary_name: "Taylor Reed",
      region_code: "US-CENTRAL",
      owner_principal_id: "99999999-9999-9999-9999-999999999999",
      modified_on_utc: "2026-05-13T20:22:00Z",
      ingest_hash: makeHash("b"),
      pii_policy_tag: "masked"
    }
  ].filter((snapshot) => entities.includes(snapshot.entity_logical_name));

  return {
    ok: true,
    statusCode: 200,
    data: {
      scan_run: {
        scan_run_id: FIXED_IDS.scanRunId,
        contract_version: CONTRACT_VERSION,
        source_system: SOURCE_SYSTEM,
        source_env: request.source_env,
        started_at_utc: FIXED_TIMESTAMPS.startedAt,
        completed_at_utc: FIXED_TIMESTAMPS.completedAt,
        status: "completed",
        extracted_entity_count: snapshots.length,
        evaluated_rule_count: 0,
        correlation_id: request.correlation_id
      },
      snapshots
    }
  };
}

export function scoreSnapshots(request) {
  if (request?.contract_version !== CONTRACT_VERSION) {
    return error("score_invalid_contract_version", `contract_version must be ${CONTRACT_VERSION}`);
  }

  if (request?.scan_run_id !== FIXED_IDS.scanRunId) {
    return error("score_unknown_scan_run", "scan_run_id not found in stub fixture");
  }

  const ruleResults = [
    {
      rule_result_id: FIXED_IDS.ruleResultPassId,
      scan_run_id: FIXED_IDS.scanRunId,
      snapshot_id: FIXED_IDS.snapshotAccountId,
      rule_id: "required_account_name",
      rule_version: "1.2.0",
      severity: "high",
      status: "pass",
      score_impact: 0,
      reason_code: "rule_satisfied",
      message: "Account name present.",
      evaluated_at_utc: FIXED_TIMESTAMPS.evaluatedAt
    },
    {
      rule_result_id: FIXED_IDS.ruleResultWarnId,
      scan_run_id: FIXED_IDS.scanRunId,
      snapshot_id: FIXED_IDS.snapshotContactId,
      rule_id: "contact_region_consistency",
      rule_version: "1.1.0",
      severity: "medium",
      status: "warn",
      score_impact: -8,
      reason_code: "region_defaulted",
      message: "Region inferred from owner business unit.",
      evaluated_at_utc: FIXED_TIMESTAMPS.evaluatedAt
    }
  ];

  return {
    ok: true,
    statusCode: 200,
    data: {
      rule_results: ruleResults,
      score_summary: {
        score_summary_id: FIXED_IDS.scoreSummaryId,
        scan_run_id: FIXED_IDS.scanRunId,
        overall_score: 92,
        completeness_score: 95,
        consistency_score: 88,
        validity_score: 93,
        fail_count: 0,
        warn_count: 1,
        pass_count: 1,
        score_band: "excellent"
      }
    }
  };
}

export function publishResults(request) {
  if (!request?.destination || !["dataverse", "lakehouse", "queue"].includes(request.destination)) {
    return error("publish_invalid_destination", "destination must be dataverse, lakehouse, or queue");
  }

  if (!Number.isInteger(request?.attempt_count) || request.attempt_count < 1) {
    return error("publish_invalid_attempt_count", "attempt_count must be >= 1");
  }

  if (request.scan_run_id !== FIXED_IDS.scanRunId) {
    return error("publish_unknown_scan_run", "scan_run_id not found in stub fixture");
  }

  return {
    ok: true,
    statusCode: 200,
    data: {
      publish_event: {
        publish_event_id: FIXED_IDS.publishEventId,
        scan_run_id: FIXED_IDS.scanRunId,
        snapshot_id: FIXED_IDS.snapshotContactId,
        destination: request.destination,
        destination_record_id: request.destination === "dataverse" ? "dv-writeback-101" : "dest-record-101",
        publish_status: "succeeded",
        attempt_count: request.attempt_count,
        published_at_utc: FIXED_TIMESTAMPS.publishedAt
      }
    }
  };
}

function error(errorCode, message) {
  return {
    ok: false,
    statusCode: 400,
    error: {
      error_code: errorCode,
      message
    }
  };
}
