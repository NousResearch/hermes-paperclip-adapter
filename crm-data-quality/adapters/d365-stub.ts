export type CanonicalEntity = "account" | "contact" | "lead";
export type StubOperation = "extract" | "score" | "publish";

export interface AdapterError {
  code: string;
  message: string;
  operation: StubOperation;
  entity?: CanonicalEntity;
  recordId?: string;
}

export interface AdapterResponse<T> {
  ok: boolean;
  data?: T;
  error?: AdapterError;
  meta: {
    adapter: "d365-stub";
    requestId: string;
    timestamp: string;
  };
}

export interface CanonicalRecord {
  id: string;
  entity: CanonicalEntity;
  name: string;
  email?: string;
  phone?: string;
  ownerId?: string;
  parentAccountId?: string;
  status: "active" | "inactive";
  source: "stub";
}

export interface ExtractRequest {
  entity: CanonicalEntity;
  ids?: string[];
  limit?: number;
}

export interface ExtractResult {
  entity: CanonicalEntity;
  records: CanonicalRecord[];
  total: number;
}

export interface ScoreRequest {
  entity: CanonicalEntity;
  records: CanonicalRecord[];
}

export interface ScoreItem {
  recordId: string;
  score: number;
  grade: "A" | "B" | "C" | "D";
  findings: string[];
}

export interface ScoreResult {
  entity: CanonicalEntity;
  scored: ScoreItem[];
  averageScore: number;
}

export interface PublishRequest {
  entity: CanonicalEntity;
  scored: ScoreItem[];
  remediationRunId: string;
}

export interface PublishResult {
  entity: CanonicalEntity;
  publishedCount: number;
  publishBatchId: string;
  status: "published";
}

export interface StubFailureRule {
  operation: StubOperation;
  entity?: CanonicalEntity;
  recordId?: string;
  code?: string;
  message?: string;
}

export interface D365Adapter {
  extract(req: ExtractRequest): Promise<AdapterResponse<ExtractResult>>;
  score(req: ScoreRequest): Promise<AdapterResponse<ScoreResult>>;
  publish(req: PublishRequest): Promise<AdapterResponse<PublishResult>>;
}

export interface D365StubAdapterOptions {
  failures?: StubFailureRule[];
  seedTimestamp?: string;
}

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const STUB_DATA: Record<CanonicalEntity, CanonicalRecord[]> = {
  account: [
    {
      id: "acct-001",
      entity: "account",
      name: "Northwind Traders",
      ownerId: "owner-01",
      status: "active",
      source: "stub",
    },
    {
      id: "acct-002",
      entity: "account",
      name: "Contoso LLC",
      ownerId: "owner-02",
      status: "inactive",
      source: "stub",
    },
  ],
  contact: [
    {
      id: "cont-001",
      entity: "contact",
      name: "Adele Vance",
      email: "adele.vance@northwind.example",
      phone: "+1-312-555-0101",
      parentAccountId: "acct-001",
      status: "active",
      source: "stub",
    },
    {
      id: "cont-002",
      entity: "contact",
      name: "Diego Siciliani",
      parentAccountId: "acct-002",
      status: "active",
      source: "stub",
    },
  ],
  lead: [
    {
      id: "lead-001",
      entity: "lead",
      name: "Fabrikam Expansion",
      email: "ops@fabrikam.example",
      ownerId: "owner-03",
      status: "active",
      source: "stub",
    },
    {
      id: "lead-002",
      entity: "lead",
      name: "Litware Renewal",
      status: "inactive",
      source: "stub",
    },
  ],
};

export function createD365StubAdapter(options: D365StubAdapterOptions = {}): D365Adapter {
  const failures = options.failures ?? [];
  const seedTimestamp = options.seedTimestamp ?? DEFAULT_TIMESTAMP;
  let sequence = 0;

  function nextRequestId(operation: StubOperation): string {
    sequence += 1;
    return `stub-${operation}-${String(sequence).padStart(4, "0")}`;
  }

  function matchFailure(
    operation: StubOperation,
    entity?: CanonicalEntity,
    recordIds: string[] = [],
  ): AdapterError | null {
    const rule = failures.find((candidate) => {
      if (candidate.operation !== operation) return false;
      if (candidate.entity && candidate.entity !== entity) return false;
      if (candidate.recordId && !recordIds.includes(candidate.recordId)) return false;
      return true;
    });

    if (!rule) return null;

    return {
      code: rule.code ?? "STUB_FORCED_FAILURE",
      message: rule.message ?? `Forced failure for ${operation}`,
      operation,
      entity,
      recordId: rule.recordId,
    };
  }

  function ok<T>(operation: StubOperation, data: T): AdapterResponse<T> {
    return {
      ok: true,
      data,
      meta: {
        adapter: "d365-stub",
        requestId: nextRequestId(operation),
        timestamp: seedTimestamp,
      },
    };
  }

  function fail<T>(operation: StubOperation, error: AdapterError): AdapterResponse<T> {
    return {
      ok: false,
      error,
      meta: {
        adapter: "d365-stub",
        requestId: nextRequestId(operation),
        timestamp: seedTimestamp,
      },
    };
  }

  return {
    async extract(req) {
      const recordIds = req.ids ?? [];
      const forced = matchFailure("extract", req.entity, recordIds);
      if (forced) return fail("extract", forced);

      let records = [...STUB_DATA[req.entity]];
      if (recordIds.length > 0) {
        const wanted = new Set(recordIds);
        records = records.filter((record) => wanted.has(record.id));
      }
      if (typeof req.limit === "number") {
        records = records.slice(0, Math.max(0, req.limit));
      }

      return ok("extract", {
        entity: req.entity,
        records,
        total: records.length,
      });
    },

    async score(req) {
      const forced = matchFailure(
        "score",
        req.entity,
        req.records.map((record) => record.id),
      );
      if (forced) return fail("score", forced);

      const scored: ScoreItem[] = req.records.map((record) => {
        let score = 40;
        const findings: string[] = [];

        if (record.name.trim().length > 0) score += 20;
        else findings.push("missing_name");

        if (record.email) score += 20;
        else findings.push("missing_email");

        if (record.phone) score += 10;
        else findings.push("missing_phone");

        if (record.status === "active") score += 10;
        else findings.push("inactive_record");

        const bounded = Math.max(0, Math.min(100, score));
        const grade = bounded >= 90 ? "A" : bounded >= 75 ? "B" : bounded >= 60 ? "C" : "D";

        return {
          recordId: record.id,
          score: bounded,
          grade,
          findings,
        };
      });

      const averageScore = scored.length === 0
        ? 0
        : Number((scored.reduce((sum, item) => sum + item.score, 0) / scored.length).toFixed(2));

      return ok("score", {
        entity: req.entity,
        scored,
        averageScore,
      });
    },

    async publish(req) {
      const forced = matchFailure(
        "publish",
        req.entity,
        req.scored.map((item) => item.recordId),
      );
      if (forced) return fail("publish", forced);

      const stableRecordKey = req.scored.map((item) => item.recordId).sort().join("-") || "none";
      const publishBatchId = `pub-${req.entity}-${req.remediationRunId}-${stableRecordKey}`;

      return ok("publish", {
        entity: req.entity,
        publishedCount: req.scored.length,
        publishBatchId,
        status: "published",
      });
    },
  };
}
