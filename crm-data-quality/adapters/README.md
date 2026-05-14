# D365 Adapter Layer (Stub)

`d365-stub.ts` provides a deterministic implementation of the planned D365 adapter surface.

## Interface Surface

The stub and eventual real adapter should both implement:

- `extract(request)`
- `score(request)`
- `publish(request)`

Callers should depend only on the `D365Adapter` interface and never import stub-only internals.

## Zero-Code-Change Swap Strategy

Use a factory that chooses adapter implementation at runtime and always returns `D365Adapter`:

```ts
import { createD365StubAdapter, type D365Adapter } from "./d365-stub";

export function createD365Adapter(mode: "stub" | "real"): D365Adapter {
  if (mode === "real") {
    // return createD365RealAdapter(...)
    throw new Error("Real adapter not implemented yet");
  }

  return createD365StubAdapter();
}
```

When the real adapter is ready, only factory wiring changes. Callers continue to use the same adapter methods and request/response shapes.

## Runtime Toggles

Recommended runtime toggle:

- `D365_ADAPTER_MODE=stub` for local and CI deterministic behavior.
- `D365_ADAPTER_MODE=real` only in environments with validated Dataverse connectivity.

## Deterministic Error Injection

`createD365StubAdapter({ failures: [...] })` allows reproducible error-path tests by operation/entity/record.

Example:

```ts
const adapter = createD365StubAdapter({
  failures: [{ operation: "publish", entity: "lead", code: "D365_THROTTLED" }],
});
```
