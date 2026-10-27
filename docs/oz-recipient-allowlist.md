# OpenZeppelin recipient-allowlist check

Checked 2026-10-27, before `merchant-allowlist-policy` was written.

## Issue #514

[OpenZeppelin/stellar-contracts#514](https://github.com/OpenZeppelin/stellar-contracts/issues/514) is an open tracker titled "Smart Accounts enhancements", opened by brozorec on 2025-12-04 and last updated 2026-07-13. The policies section asks for implementation guidelines. It does not propose a recipient allowlist, a merchant allowlist, or any policy that constrains the `to` argument of `transfer`.

Comments on that issue (kalepail, through 2026-07-13) ask for:

- a `Vec` of `CallContract` targets on one rule
- batch context-rule updates
- an official way to update policy parameters
- a note that the client SDK lives in smart-account-kit

None of those is a recipient allowlist.

## Nearby issues

| Issue | State | What it actually is |
| --- | --- | --- |
| [#649](https://github.com/OpenZeppelin/stellar-contracts/issues/649) | closed | The existing `spending_limit` policy. It caps an amount over a rolling window. It does not name a recipient. |
| [#850](https://github.com/OpenZeppelin/stellar-contracts/issues/850) | open | An external policy generator, because the built-in policies do not scope function arguments. |
| [#858](https://github.com/OpenZeppelin/stellar-contracts/issues/858) | open | A proposed `frequency_limit` (how often a call is allowed, not who receives it). |
| [#880](https://github.com/OpenZeppelin/stellar-contracts/issues/880), [#881](https://github.com/OpenZeppelin/stellar-contracts/issues/881), [#941](https://github.com/OpenZeppelin/stellar-contracts/issues/941) | token work | Fungible-token allowlist and blocklist extensions. They are not smart-account policies and they do not constrain a payment recipient. |

A search of the tracker for allowlist, recipient, merchant, and spending policies did not turn up a planned recipient-allowlist policy.

## What this repository does

`stellar-accounts` 0.8.0 (crates.io, 2026-10-20, soroban-sdk 28.0.0) publishes the `Policy` trait (`install`, `enforce`, `uninstall`). `merchant-allowlist-policy` implements that trait as its own contract. Per-asset rolling caps stay on the published `spending_limit` contract. This repository does not reimplement it.

The released testnet `spending_limit` singleton from the stellar-accounts 0.8.0 deployment is `CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5`.
