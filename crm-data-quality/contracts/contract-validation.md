# CRM-DQ Contract Validation (Eng-2)

## Contract files
- `d365-crm-dq-api.yaml`: OpenAPI 3.1 interface contract for `extract`, `score`, `publish`.

## Validation / lint command
Use Redocly CLI to lint the contract:

```bash
npx @redocly/cli lint crm-data-quality/contracts/d365-crm-dq-api.yaml
```

## Stub usage
Stub implementation and deterministic fixtures are in:
- `crm-data-quality/stubs/d365-stub-service.mjs`

Run the local stub smoke tests:

```bash
node --test crm-data-quality/tests/unit/d365-stub-service.test.mjs
```
