# CRM-DQ QA-1 Test Plan

Parent issues: [VER-303](/VER/issues/VER-303), [VER-280](/VER/issues/VER-280)

## 1. Objectives

This plan defines how CRM-DQ quality is verified before and after live Dataverse environment access. The intent is to prove deterministic behavior, contract integrity, and release readiness through pre-env gates first, then close live-env parity and performance risk with targeted env-dependent validation.

## 2. Scope Boundaries

### In scope

- Pre-env verification of contract, schema, stub adapter, and CI quality gates.
- Traceability from engineering gates to verification evidence.
- Separation of tests that can run without credentials vs tests that require tenant/auth access.
- Risk/mitigation tracking with explicit owners.

### Out of scope (for this QA-1 plan execution)

- Executing live Dataverse validation runs without environment prerequisites.
- Defining production incident response procedures beyond test readiness context.
- Redefining architecture decisions already covered in ADRs.

## 3. Test Layers

| Layer | Purpose | Primary artifacts | Env dependency |
| --- | --- | --- | --- |
| Unit | Verify deterministic logic and data transforms in isolation | `crm-data-quality/tests/unit/*`, adapter unit suites | Pre-env |
| Contract | Validate API/schema conformance and backward-compatibility expectations | `crm-data-quality/contracts/*`, contract lint/validation docs | Pre-env |
| Stub integration | Verify end-to-end flow behavior against deterministic stub service | `crm-data-quality/adapters/d365-stub.ts`, `crm-data-quality/stubs/*` | Pre-env |
| CI gate validation | Enforce lint/unit/contract checks as merge requirements | CI workflow artifacts for Eng-7 and Epic 4 | Pre-env |
| Live-env integration | Validate tenant/auth handshake and behavior parity with Dataverse | live-env handshake checklist and parity evidence | Env-dependent |
| Performance and scale | Confirm throughput/latency thresholds on representative live data | benchmark evidence and threshold sign-off | Env-dependent |

## 4. Pre-Env vs Env-Dependent Partition

### Pre-env lane (must complete before live env work)

- Eng-1 ADR alignment checkpoints.
- Eng-2 contract and stub interface validation.
- Eng-3 dependency-map consistency and updates.
- Eng-4 epic decomposition traceability.
- Eng-5 schema/entity model validation against contracts.
- Eng-7 CI/CD non-env gate scaffolding.
- Eng-8 deterministic stub adapter behavior.
- QA-1 test plan (this artifact).
- QA-3 acceptance criteria traceability.
- QA-5 non-env unit tests in CI.

### Env-dependent lane (requires FoundingEngineer-provided prerequisites)

- Eng-6 integration/auth handshake validation.
- QA-2 live integration test cases per Dataverse endpoint.
- QA-4 performance benchmark calibration and execution.

## 5. Gate-to-Verification Matrix

| Gate | Tracker | Verification method | Evidence artifact | Env dependency |
| --- | --- | --- | --- | --- |
| Eng-1 ADRs for D365 data model integration | [VER-285](/VER/issues/VER-285) | ADR review checklist + consistency scan against contracts/schema assumptions | ADR files under `crm-data-quality/docs/adr/*` with explicit validation checkpoints | Pre-env |
| Eng-2 Interface contracts and stub services | [VER-286](/VER/issues/VER-286) | Contract lint/validation run and stub signature checks | `crm-data-quality/contracts/d365-crm-dq-api.yaml`, `crm-data-quality/contracts/contract-validation.md` | Pre-env |
| Eng-3 Environment dependency map | [VER-296](/VER/issues/VER-296) | Gate table refresh + dependency audit for env requirements | `crm-data-quality/docs/environment-dependency-map.md` | Pre-env |
| Eng-4 Epic decomposition | [VER-287](/VER/issues/VER-287) | Sequence/dependency review against delivery artifacts | `crm-data-quality/docs/epic-decomposition.md` | Pre-env |
| Eng-5 Schema and entity models | [VER-288](/VER/issues/VER-288) | Entity contract traceability checks and schema constraint validation | `crm-data-quality/docs/schema/entity-contracts.md`, related schema outputs | Pre-env |
| Eng-6 Integration/auth handshake validation | Scope gap (dedicated issue required) | Tenant connectivity/auth handshake test with evidence capture | live-env handshake checklist + connection validation evidence | Env-dependent |
| Eng-7 CI/CD pipeline scaffolding | [VER-289](/VER/issues/VER-289) | CI dry run proving lint/unit/contract gates fail/pass correctly | CI workflow run logs and artifacts | Pre-env |
| Eng-8 D365 stub adapter layer | [VER-290](/VER/issues/VER-290) | Deterministic adapter tests across happy/error paths | adapter code + unit test evidence | Pre-env |
| QA-1 Test plan | [VER-303](/VER/issues/VER-303) | Plan completeness review against acceptance criteria | `crm-data-quality/test/PLAN.md` | Pre-env |
| QA-2 Test cases per D365 integration point | [VER-292](/VER/issues/VER-292) | Execute live-path test cases against seeded tenant data | `crm-data-quality/tests/test-cases.md` + execution evidence | Env-dependent |
| QA-3 Acceptance criteria per epic | [VER-293](/VER/issues/VER-293) | Clause-to-epic trace matrix review | `crm-data-quality/tests/acceptance-criteria.md` | Pre-env |
| QA-4 Performance benchmarks | [VER-294](/VER/issues/VER-294) | Baseline and stress runs compared with agreed thresholds | `crm-data-quality/tests/performance-benchmarks.md` + benchmark outputs | Env-dependent |
| QA-5 Non-env unit tests in CI | [VER-295](/VER/issues/VER-295) | CI enforcement that unit suite passes pre-merge | unit suite reports and CI status | Pre-env |

## 6. Entry Criteria

- Current ADR, contract, and schema artifacts are accessible in-repo.
- Stub adapter and unit test harness are runnable in local/CI environments.
- Gate owners and issue mapping are confirmed.
- For env-dependent lane only: tenant endpoint, auth principal, and seeded datasets are provided by FoundingEngineer.

## 7. Exit Criteria

### Pre-env exit

- All pre-env gates have traceable verification evidence and no unresolved critical defects.
- CI gates for lint/unit/contract checks are green for current scope.
- QA-1, QA-3, and QA-5 artifacts are complete and cross-referenced.

### Env-dependent exit

- Eng-6, QA-2, and QA-4 have executed evidence with pass/fail disposition.
- Any parity gaps are logged with owner and remediation plan.
- Remaining defects are accepted as follow-up issues with severity and due sequence.

## 8. Execution Strategy

1. Run pre-env gates in dependency order to minimize churn (`Eng-1` -> `Eng-8`, then `QA-1/3/5`).
2. Enforce verification evidence per gate before advancing the lane.
3. Freeze interface/schema baselines before live-env validation to reduce parity noise.
4. Once environment prerequisites are supplied, execute env-dependent tests in sequence: handshake -> live test cases -> performance.
5. Record all failures as issue-linked defects with reproduction steps and artifact pointers.

## 9. Risks, Mitigations, and Owners

| Risk | Impact | Mitigation | Owner |
| --- | --- | --- | --- |
| Contract/schema drift between Eng-2 and Eng-5 | False positives and integration rework | Gate schema changes through contract traceability review before merge | CodexCoder |
| Stub behavior diverges from expected live semantics | Low confidence before env onboarding | Add deterministic fixture coverage for error/retry edge cases and document assumptions | CodexCoder |
| Missing tenant/auth prerequisites for Eng-6, QA-2, QA-4 | Live validation blocked | FoundingEngineer provides endpoint, credentials path, and seed-data checklist before env lane starts | FoundingEngineer |
| Performance thresholds set without representative data | Invalid benchmark conclusions | Delay final threshold sign-off until live dataset profile is confirmed | FoundingEngineer |
| Acceptance traceability gaps across epics | Incomplete release readiness evidence | Maintain gate-to-verification matrix and require evidence links per gate | CodexCoder |

## 10. Verification Method for This Artifact

- Manual document review against VER-303 acceptance criteria.
- Consistency check against `crm-data-quality/docs/environment-dependency-map.md` gate split.
- Confirm all engineering gates in current map are represented with a verification method.
