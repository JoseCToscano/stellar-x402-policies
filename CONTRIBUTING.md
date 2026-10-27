# Contributing

Thanks for helping smart accounts pay over x402. This repository is Apache-2.0.

## Setup

- Node.js 22 or newer
- pnpm 10 (`packageManager` in the root `package.json`)
- Rust stable with the `wasm32v1-none` target (`rust-toolchain.toml`)

```bash
pnpm install
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

`pnpm test` runs vitest in `packages/verifier`, `packages/sdk`, and `packages/mcp`. The verifier tests cover event classification, muxed-contract (W) recipient matching, and the warm and cold fee caps, and they compare this package with `ExactStellarScheme` from `@x402/stellar` 2.28.x. The MCP test spawns the stdio server.

`cargo test --manifest-path contracts/Cargo.toml` runs the Soroban policy tests. `cargo test --manifest-path contracts/Cargo.toml -p merchant-allowlist-policy --features p30` runs the Protocol 30 muxed-destination matcher. Wasm builds use `stellar contract build` (stellar-cli 28.1, which sets the spec-shaking flag soroban-sdk 28 requires).

## Layout

- `packages/verifier` — `stellar-x402-policies`
- `packages/sdk` — `@stellar-x402-policies/sdk`
- `packages/mcp` — stdio MCP server (`inspect_account`, `pay`, `estimate_fee`)
- `contracts/merchant-allowlist-policy` and `contracts/period-cap-policy` — Soroban policies on stellar-accounts 0.8.0
- `templates/` — allowance templates compiled by the kit
- `examples/facilitator` — `GET /supported`, `POST /verify`, `POST /settle`
- `examples/testnet-demo` — config printout, plus verify and optional settle on testnet

## Secrets

Put seeds, RPC URLs that embed credentials, and signed payloads in the environment or in a gitignored `.env`. `.env.example` lists the variable names with empty secrets. Do not commit `.env`, account seeds, or live transaction XDR.

The demo and the facilitator log public addresses, fee caps, and contract counts. They do not log secret keys.

## Changes

Keep the reference checks in `ExactStellarScheme` for the single transfer, payer authorization, sub-invocations, and the fee comparison. Extend the allowlist and the fee profile here when a policy event or a measured fee needs a new case, and add a unit test for that case.

`@x402/stellar` stays on 2.28.x until this package is updated for a newer event-scan API.

## CI

GitHub Actions runs lint, build, typecheck, test, and `cargo test` (including the `p30` feature) on pull requests. Run the same commands locally before pushing.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0.
