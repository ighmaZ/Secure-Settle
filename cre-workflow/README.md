# SecureSettle CRE Workflow

CRE-first workflow scaffold for SecureSettle OTC matching, adapted from the Chainlink GCP prediction market demo structure.

## Local simulation (stubbed confidential compute)

1. `cd /Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc`
2. `bun install`
3. `bun run simulate`

This seeds demo proposals into `cre-workflow/.local/secure-settle-store.json` and runs one cron-style matching cycle.

## EIP-712 `/balances` auth payload (for live Convergence position checks)

- Generate typed data for MetaMask signing:
  - `bun run balances-typed-data <seller-wallet-address>`
- Sign the JSON with `eth_signTypedData_v4`
- Include the resulting signed request payload in the seller proposal under `convergenceBalancesAuth`:
  - `{ "account": "...", "timestamp": 1234567890, "auth": "0x<signature>" }`


## What is intentionally stubbed

- Durable CRE runtime persistence and production capability wiring (the entrypoint exists, but uses bootstrap in-memory store and stub/live-toggle adapters)
- Real Confidential Compute / TEE integration
- Real Convergence API HTTP calls with EIP-712 signed payloads (`/balances`, `/transactions`, `/private-transfer`, `/withdraw`, `/shielded-address`)
- Settlement transaction writes

## CRE runtime modes (current scaffold)

`/Users/ighmaz/SecureSettle/cre-workflow/secure-settle-otc/config.json` now supports:

- `convergence.mode`: `stub | live`
- `confidentialCompute.mode`: `stub | http`

Notes:
- `convergence.mode=live` uses CRE HTTP capability calls to `POST /balances` (requires seller-signed `convergenceBalancesAuth` in the proposal payload).
- `confidentialCompute.mode=http` calls a configured endpoint (`confidentialCompute.endpointUrl`) and expects a response matching the internal `AttestedMatchResult` schema.
- The workflow still uses an in-memory store in CRE runtime mode (by design for now); durable persistence is not yet implemented.
- `demo.allowBootstrapAdapters` must be `true` to run the current CRE entrypoint with bootstrap adapters. Set it to `false` to fail closed until durable persistence / real adapters are wired.
