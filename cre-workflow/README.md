# SecureSettle CRE Workflow

This folder contains the CRE-first backend for SecureSettle OTC matching.

## What exists now

- One CRE workflow: `/Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc`
- Two triggers:
  - `cron` trigger: scans proposals and runs matching cycles
  - `http` trigger: accepts proposal batches directly and evaluates them
- Confidential external calls use `ConfidentialHTTPClient`:
  - proposal source fetch (`proposalSourceUrl`)
  - benchmark fetch (`benchmarkUrl`)
  - result sink post (`resultSinkUrl`)

## Privacy model in this version

- API calls are made via CRE Confidential HTTP capability.
- Optional secret-backed Authorization header is injected using vault secrets (`vaultDonSecrets` + `{{.secretKey}}` template).
- Workflow logs are redacted-by-design:
  - logs only counts/status
  - does not log raw proposal JSON payloads

## Current workflow logic

1. Load proposals (from confidential source URL or local fallback fixture).
2. Pair BUY and SELL proposals for same asset and settlement token.
3. Run checks:
   - sanctions list check
   - AML notional threshold check
   - quantity compatibility
   - price tolerance
   - optional benchmark deviation check
4. Emit decisions:
   - `MATCH`
   - `NO_MATCH`
   - `REJECTED_COMPLIANCE`
5. Post the result set to `resultSinkUrl` through Confidential HTTP (if configured).

## Configuration

Main file: `/Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc/config.json`

Important fields:

- `proposalSourceUrl`, `benchmarkUrl`, `resultSinkUrl`
  - must be `https://` for non-local endpoints
- `authHeaderSecretKey`
  - if set, adds header `Authorization: Bearer {{.<authHeaderSecretKey>}}`
- `owner`, `secretNamespace`
  - optional vault secret scope controls
- `encryptResultSinkResponse`
  - enables confidential output encryption for result sink call

## Secrets

- File: `/Users/ighmaz/SecureSettle/cre-workflow/secrets.yaml`
- Example template: `/Users/ighmaz/SecureSettle/cre-workflow/secrets.yaml.example`
- For this Convergence hackathon flow, no API key is required by default.
- If you add a bearer token later, put it in `secrets.yaml` and reference its key name in `authHeaderSecretKey`.

## Local validation

From `/Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc`:

```bash
bun install
bun run typecheck
```

## CRE simulation

From `/Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc`:

```bash
bunx cre workflow simulate secure-settle-otc --target local-simulation
```

Notes:

- CRE CLI login is required (`cre login`).
- In restricted/offline environments, simulation may fail during auth/token refresh.
- Typecheck can still be used as the first gating check when simulation is blocked.
