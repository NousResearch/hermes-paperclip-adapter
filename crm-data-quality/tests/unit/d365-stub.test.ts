import test from "node:test";
import assert from "node:assert/strict";

import { createD365StubAdapter, type D365Adapter } from "../../adapters/d365-stub.ts";

test("stub adapter exposes full interface", async () => {
  const adapter: D365Adapter = createD365StubAdapter();

  assert.equal(typeof adapter.extract, "function");
  assert.equal(typeof adapter.score, "function");
  assert.equal(typeof adapter.publish, "function");
});

test("extract + score + publish returns deterministic payloads", async () => {
  const adapter = createD365StubAdapter({ seedTimestamp: "2026-03-01T00:00:00.000Z" });

  const extract = await adapter.extract({ entity: "contact" });
  assert.equal(extract.ok, true);
  assert.equal(extract.meta.timestamp, "2026-03-01T00:00:00.000Z");
  assert.equal(extract.data?.entity, "contact");
  assert.equal(extract.data?.total, 2);
  assert.equal(extract.data?.records[0]?.id, "cont-001");

  const score = await adapter.score({
    entity: "contact",
    records: extract.data?.records ?? [],
  });
  assert.equal(score.ok, true);
  assert.equal(score.data?.scored.length, 2);
  assert.equal(score.data?.averageScore, 85);

  const publish = await adapter.publish({
    entity: "contact",
    scored: score.data?.scored ?? [],
    remediationRunId: "run-123",
  });
  assert.equal(publish.ok, true);
  assert.equal(publish.data?.publishBatchId, "pub-contact-run-123-cont-001-cont-002");
  assert.equal(publish.data?.status, "published");
});

test("failure rules inject deterministic error payloads", async () => {
  const adapter = createD365StubAdapter({
    failures: [
      {
        operation: "extract",
        entity: "lead",
        code: "D365_TIMEOUT",
        message: "Stubbed timeout",
      },
    ],
  });

  const result = await adapter.extract({ entity: "lead" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.operation, "extract");
  assert.equal(result.error?.code, "D365_TIMEOUT");
  assert.equal(result.error?.message, "Stubbed timeout");
});
