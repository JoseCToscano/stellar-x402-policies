# Threat model

This is the threat model for the agent spending-policy kit. The chain is the enforcement boundary. The SDK, the MCP server, and `sxp` are clients of that boundary.

| Threat | Mitigation |
| --- | --- |
| Relaxed event check hides a second balance move | Balance-topic denylist on every event; still exactly one transfer; allowlisted emitters only; no sub-invocations; negative tests |
| Malicious "policy" contract added to the allowlist | Allowlist by contract and wasm hash; registry mode signed by the operator; conformance tests with a hostile policy |
| Fee griefing (payer forces a huge cold fee) | Warm/cold ceilings, simulation-bound resource limits, per-payer rate limits in the facilitator |
| Prompt injection drains the agent | Chain-enforced caps, merchant allowlist, `valid_until`, per-tx max; the owner rule needs a passkey |
| Replay or front-running of auth entries | Soroban nonces plus signature expiration ledger; the facilitator settles exactly the verified transaction |
| History exhaustion (815 entries) blocks payments | The inspector warns as the history nears capacity; the templates pick period sizes to fit |
| W-address confusion after Protocol 30 | The verifier compares the base contract and the mux id; tests cover C, W, and G recipients |
| Agent key leak | Short `valid_until`; the owner rotates or removes the rule; the MCP server never sees the owner key |

`sxp allowlist export` prints `X402_POLICY_EVENT_CONTRACTS` from `deployments/testnet.json`. The facilitator also reads `POLICY_CONTRACT_IDS`. Both lists are merged. A policy event is accepted only when its contract is on that list and its topic is not balance-moving (`transfer`, `mint`, `burn`, `clawback`, `approve`, `set_authorized`).

The agent key in `SXP_AGENT_SECRET` can sign only the rules that list it. It cannot install or edit policies. Those calls require the owner rule.
