# Contributing

Thanks for helping smart accounts pay over x402. This repository is Apache-2.0.

## Setup

- Node.js 22 or newer
- pnpm 10 (`packageManager` in the root `package.json`)

```bash
pnpm install
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

`pnpm test` runs the vitest suite in `packages/core`. The tests cover event classification and the warm and cold fee caps, and they compare this package with `ExactStellarScheme` from `@x402/stellar` 2.28.x.

## Layout

- `packages/core` — `stellar-x402-policies`
- `examples/facilitator` — `GET /supported`, `POST /verify`, `POST /settle`
- `examples/testnet-demo` — config printout, plus verify and optional settle on testnet

## Secrets

Put seeds, RPC URLs that embed credentials, and signed payloads in the environment or in a gitignored `.env`. `.env.example` lists the variable names with empty secrets. Do not commit `.env`, account seeds, or live transaction XDR.

The demo and the facilitator log public addresses, fee caps, and contract counts. They do not log secret keys.

## Changes

Keep the reference checks in `ExactStellarScheme` for the single transfer, payer authorization, sub-invocations, and the fee comparison. Extend the allowlist and the fee profile here when a policy event or a measured fee needs a new case, and add a unit test for that case.

`@x402/stellar` stays on 2.28.x until this package is updated for a newer event-scan API.

## CI

GitHub Actions runs lint, build, typecheck, and test on pull requests. Run the same commands locally before pushing.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0.
