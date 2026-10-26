# Testnet results

Live run on 2026-10-26 against Stellar testnet, RPC `https://soroban-testnet.stellar.org`. `pnpm live` generated the keypairs in memory and funded the Stellar accounts with Friendbot. No seed and no `.env` file were written.

The account contract is the OpenZeppelin stellar-contracts smart account at commit `1e513890`, using the WASM and singletons published for protocol 27. Each payment is a 0.1 XLM SEP-41 transfer (1,000,000 stroops) of the native asset contract under a 1 XLM spending limit.

| Piece | Id |
| --- | --- |
| Account WASM | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a` |
| Ed25519 verifier | `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4` |
| Spending-limit policy | `CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G` |
| Native asset contract | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Smart account | `CA37FAB2OXRQLTMKR36QXMT3JREOVIEDDK7SW3YCAB6NRZZNZUG7K7BV` |
| Facilitator (fee payer) | `GAWUFGW6J7FJO555H3CZ3UJFOJQFPYRNFO37VFGQPCD2FSL4IEEU5LHO` |
| Merchant | `GC5IALVEOMPMRB76NHSEE3OYNG4IZXK6RQMHZYVCKSDCPVKTPM5AH5CT` |

## Reference scheme

`ExactStellarScheme` from `@x402/stellar` 2.28.0 simulated the first payment and rejected it. The payload was not submitted.

| Ceiling | Result |
| --- | --- |
| Default 50,000 stroops | `invalid_exact_stellar_payload_fee_exceeds_maximum` — simulation-derived fee 369,788 stroops exceeds ceiling 50,000 stroops |
| Raised above that fee | `invalid_exact_stellar_payload_event_not_transfer` |

The fee check runs first, so the default ceiling never reaches the event scan. With the ceiling raised, the scan stops on `spending_limit_enforced` from the policy contract. The native asset contract also emitted the matching `transfer`. Diagnostic events are ignored by the reference scan.

## Settlements

`examples/facilitator` ran `PolicyAwareExactStellarScheme` with `FEE_PROFILE=cold`, `POLICY_CONTRACT_IDS` set to the spending-limit contract, and `POLICY_EVENT_TOPICS=spending_limit_enforced`. The cold cap stayed at its default, 6,500,000 stroops. Both payments verified and settled.

The simulated fee is `minResourceFee` plus the 100-stroop inclusion buffer, which is the number the scheme compares with the cap. The charged fee is what the ledger recorded after the resource refund.

| Payment | Ledger | Simulated fee (stroops) | Charged fee (stroops) | Transaction |
| --- | ---: | ---: | ---: | --- |
| Cold. First enforce of the spending limit, which extends the policy entry TTL | 5,405,125 | 369,788 | 318,897 | [`2ecdc5d2ff530b0347a9bf6d8033f162036ccbd9ee435328b84c5adf0d61ea38`](https://stellar.expert/explorer/testnet/tx/2ecdc5d2ff530b0347a9bf6d8033f162036ccbd9ee435328b84c5adf0d61ea38) |
| Warm. The next payment, after that TTL extension | 5,405,126 | 58,328 | 48,067 | [`eee416ae7b39839ab689e63ffb2a8e33924f4b6fb906f973eb47778dc16eef01`](https://stellar.expert/explorer/testnet/tx/eee416ae7b39839ab689e63ffb2a8e33924f4b6fb906f973eb47778dc16eef01) |

369,788 stroops is 0.0369788 XLM. 318,897 stroops charged is 0.0318897 XLM. The warm payment simulated at 0.0058328 XLM and was charged 0.0048067 XLM.

This run's first-touch rent is the gap between those two simulations (about 311,460 stroops). It is the same order of magnitude as the earlier warm-band reports (310,000–324,039 stroops), not the separate 5.71 million stroop cold measurement. The published cold cap of 6,500,000 stroops still covered the payment.

The warm simulation fee, 58,328 stroops, is still above the reference default of 50,000. The reference scheme was invoked on the cold payload only.

## Setup

These transactions created the account, moved 5 XLM into it, and added the `CallContract` spending-limit rule (limit 1 XLM, period 17,280 ledgers). Rule 0 is the constructor's default rule and authorized `add_context_rule`. The payments used rule 1, so the policy ran.

| Step | Charged fee (stroops) | Transaction |
| --- | ---: | --- |
| Deploy account | 102,747 | [`72943d27480f6965c4780e7609047d9c95919625a0b2fa8b17cf2aac71bd8b8f`](https://stellar.expert/explorer/testnet/tx/72943d27480f6965c4780e7609047d9c95919625a0b2fa8b17cf2aac71bd8b8f) |
| Fund 5 XLM | 100,909 | [`cd6b9960027cbe0c00159137c7658ae4de6621f2976eb61ce798bb08b27c9138`](https://stellar.expert/explorer/testnet/tx/cd6b9960027cbe0c00159137c7658ae4de6621f2976eb61ce798bb08b27c9138) |
| Install spending limit | 344,066 | [`acf90166a0c253b88d77182bcdac6785e19fe07038910665b7847b2a080279b7`](https://stellar.expert/explorer/testnet/tx/acf90166a0c253b88d77182bcdac6785e19fe07038910665b7847b2a080279b7) |
