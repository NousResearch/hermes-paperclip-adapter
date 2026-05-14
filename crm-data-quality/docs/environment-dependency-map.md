# CRM-DQ Environment Dependency Map

Source set: current CRM-DQ Eng/QA gate issues in the VER board, anchored to [VER-280](/VER/issues/VER-280) and expanded through [VER-307](/VER/issues/VER-307).

## Gate Dependency Table

| Gate | Tracker Issue | Primary Artifact | needs_live_env | Unblock Owner | Next Action |
|---|---|---|---|---|---|
| Eng-1 ADRs for D365 data model integration | [VER-285](/VER/issues/VER-285) | `crm-data-quality/docs/adrs/*.md` | No | CodexCoder | Finalize ADR set with stub assumptions and mark explicit live-env validation checkpoints. |
| Eng-2 Interface contracts and stub services | [VER-286](/VER/issues/VER-286) | `crm-data-quality/contracts/*`, `crm-data-quality/adapters/d365-stub.ts` | No | CodexCoder | Publish contract schema + stub signatures aligned to ADR entities. |
| Eng-3 Environment dependency map | [VER-296](/VER/issues/VER-296) | `crm-data-quality/docs/environment-dependency-map.md` | No | CodexCoder | Keep this map updated as gate status changes or new env constraints are discovered. |
| Eng-4 Epic decomposition (5-8 child epics) | [VER-287](/VER/issues/VER-287) | `crm-data-quality/docs/epic-decomposition.md` | No | CodexCoder | Split implementation into child epics with explicit env/no-env labels. |
| Eng-5 Schema design and entity models | [VER-288](/VER/issues/VER-288) | `crm-data-quality/schema/*` and model definitions | No | CodexCoder | Draft canonical entities and constraints from ADR decisions; flag fields requiring Dataverse metadata confirmation. |
| Eng-6 Integration/auth handshake validation gate (missing discrete issue) | Scope gap (no dedicated issue yet) | Env handshake checklist + connection validation evidence | Yes | FoundingEngineer | Create/assign a dedicated Eng-6 issue and attach tenant/auth prerequisites for environment onboarding. |
| Eng-7 CI/CD pipeline scaffolding | [VER-289](/VER/issues/VER-289) | `.github/workflows/*` or equivalent CI config | No | CodexCoder | Wire lint/test/build with non-env test lane and artifacts publishing. |
| Eng-8 D365 stub adapter layer | [VER-290](/VER/issues/VER-290) | `crm-data-quality/adapters/d365-stub.ts` | No | CodexCoder | Implement deterministic stub adapter behavior for local + CI test scenarios. |
| QA-1 Test plan | [VER-291](/VER/issues/VER-291) | `crm-data-quality/tests/test-plan.md` | No | CodexCoder | Define scope matrix: unit, contract, integration (stub/live), perf, and acceptance paths. |
| QA-2 Test cases per D365 integration point | [VER-292](/VER/issues/VER-292) | `crm-data-quality/tests/test-cases.md` | Yes | FoundingEngineer | Provide tenant endpoint + seeded sample data so live-path test cases can be executed. |
| QA-3 Acceptance criteria per epic | [VER-293](/VER/issues/VER-293) | `crm-data-quality/tests/acceptance-criteria.md` | No | CodexCoder | Derive measurable acceptance statements from each Eng gate/child epic. |
| QA-4 Performance benchmarks | [VER-294](/VER/issues/VER-294) | `crm-data-quality/tests/performance-benchmarks.md` | Yes | FoundingEngineer | Confirm live env dataset profile and SLAs; then calibrate benchmark thresholds. |
| QA-5 Non-env unit tests in CI | [VER-295](/VER/issues/VER-295) | `crm-data-quality/tests/unit/*` + CI job wiring | No | CodexCoder | Implement baseline unit suite against stubs and enforce in CI as merge gate. |

## Proposed Pre-Env Execution Sequence

1. Complete no-env architecture and interface definition gates: Eng-1, Eng-2, Eng-3.
2. Decompose and design implementation shape before env access: Eng-4, Eng-5.
3. Build deterministic delivery scaffolding and stub behavior: Eng-7, Eng-8.
4. Establish QA backbone without live tenant dependency: QA-1, QA-3, QA-5.
5. Once environment prerequisites are provided by FoundingEngineer, execute live-env dependent gates: Eng-6, QA-2, QA-4.

## Live-Env Critical Path Notes

- Live environment is required only for tenant/auth handshake and validation against real Dataverse behaviors (Eng-6, QA-2, QA-4).
- Remaining gates are intentionally staged to maximize parallel no-env progress and reduce idle time before env provisioning.
