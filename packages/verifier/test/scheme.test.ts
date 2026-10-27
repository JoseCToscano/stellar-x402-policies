/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VerifyResponse } from "@x402/core/types";
import { xdr } from "@stellar/stellar-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { describe, expect, it } from "vitest";

import {
  COLD_FEE_MEASURED_STROOPS,
  DEFAULT_COLD_FEE_CAP_STROOPS,
  DEFAULT_WARM_FEE_CAP_STROOPS,
  REFERENCE_MAX_TRANSACTION_FEE_STROOPS,
  WARM_FEE_OBSERVED_SETTLEMENT_STROOPS,
} from "../src/constants.js";
import { PolicyAwareExactStellarScheme } from "../src/scheme.js";
import { readPolicyAwareOptions } from "../src/env.js";
import {
  ASSET,
  FROM,
  POLICY,
  TO,
  contractEvent,
  i128,
  policyEvent,
  signer,
  symbol,
  transferEvent,
} from "./fixtures.js";

const AMOUNT = 1000n;

interface EventChecker {
  validateSimulationEvents(
    events: xdr.DiagnosticEvent[],
    fromAddress: string,
    toAddress: string,
    expectedAmount: bigint,
    expectedAsset: string,
  ): VerifyResponse | undefined;
}

function check(
  scheme: ExactStellarScheme,
  events: xdr.DiagnosticEvent[],
  amount: bigint = AMOUNT,
): VerifyResponse | undefined {
  return (scheme as unknown as EventChecker).validateSimulationEvents(
    events,
    FROM,
    TO,
    amount,
    ASSET,
  );
}

describe("PolicyAwareExactStellarScheme", () => {
  it("raises the fee ceiling above the reference 50,000 stroops", () => {
    const reference = new ExactStellarScheme([signer]);
    expect(reference.maxTransactionFeeStroops).toBe(REFERENCE_MAX_TRANSACTION_FEE_STROOPS);

    const warm = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
      feeProfile: "warm",
    });
    expect(warm.maxTransactionFeeStroops).toBe(DEFAULT_WARM_FEE_CAP_STROOPS);
    expect(warm.maxTransactionFeeStroops).toBeGreaterThan(WARM_FEE_OBSERVED_SETTLEMENT_STROOPS);

    const cold = new PolicyAwareExactStellarScheme([signer], { feeProfile: "cold" });
    expect(cold.maxTransactionFeeStroops).toBe(DEFAULT_COLD_FEE_CAP_STROOPS);
    expect(cold.maxTransactionFeeStroops).toBeGreaterThan(COLD_FEE_MEASURED_STROOPS);

    const custom = new PolicyAwareExactStellarScheme([signer], {
      feeProfile: "warm",
      maxTransactionFeeStroops: 123_456,
    });
    expect(custom.maxTransactionFeeStroops).toBe(123_456);
    expect(custom.feeProfile.capSource).toBe("override");
  });

  it("publishes the ceiling and allowlist on getExtra", () => {
    const scheme = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
      policyEventTopics: ["spending_limit_enforced"],
      feeProfile: "warm",
    });
    expect(scheme.getExtra("stellar:testnet")).toMatchObject({
      areFeesSponsored: true,
      feeProfile: "warm",
      maxTransactionFeeStroops: DEFAULT_WARM_FEE_CAP_STROOPS,
      policyEventContracts: [POLICY],
      policyEventTopics: ["spending_limit_enforced"],
    });
  });

  it("accepts a policy event that the reference scheme rejects as not a transfer", () => {
    const events = [policyEvent(), transferEvent()];
    const reference = check(new ExactStellarScheme([signer]), events);
    expect(reference?.invalidReason).toBe("invalid_exact_stellar_payload_event_not_transfer");

    const allowed = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
    });
    expect(check(allowed, events)).toBeUndefined();
  });

  it("keeps the reference rule of exactly one matching transfer", () => {
    const scheme = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
    });
    expect(check(scheme, [policyEvent()])?.invalidReason).toBe(
      "invalid_exact_stellar_payload_no_transfer_events",
    );
    expect(check(scheme, [transferEvent(), transferEvent()])?.invalidReason).toBe(
      "invalid_exact_stellar_payload_multiple_transfers",
    );
    expect(check(scheme, [transferEvent(1001n)])?.invalidReason).toBe(
      "invalid_exact_stellar_payload_event_wrong_amount",
    );
  });

  it("rejects a balance-moving event from an allowlisted policy contract", () => {
    const scheme = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
      policyEventTopics: ["spending_limit_enforced"],
    });
    const result = check(scheme, [policyEvent("mint"), transferEvent()]);
    expect(result?.isValid).toBe(false);
    expect(result?.invalidReason).toBe("invalid_exact_stellar_payload_rejected_event");
    expect(result?.invalidMessage).toContain("balance_moving_topic");
  });

  it("rejects a policy event when that contract is not allowlisted", () => {
    const scheme = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [],
    });
    const result = check(scheme, [policyEvent(), transferEvent()]);
    expect(result?.invalidMessage).toContain("emitter_not_allowlisted");
  });

  it("uses each instance's own allowlist", () => {
    const events = [policyEvent("simple_enforced"), transferEvent()];
    const open = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
    });
    const filtered = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
      policyEventTopics: ["spending_limit_enforced"],
    });
    expect(check(open, events)).toBeUndefined();
    expect(check(filtered, events)?.invalidMessage).toContain("topic_not_allowlisted");
  });

  it("leaves diagnostic events for the reference scan to ignore", () => {
    const scheme = new PolicyAwareExactStellarScheme([signer], {
      policyContracts: [POLICY],
    });
    const diagnostic = contractEvent(
      null,
      [symbol("fn_call")],
      i128(1n),
      "diagnostic",
    );
    expect(check(scheme, [diagnostic, policyEvent(), transferEvent()])).toBeUndefined();
  });

  it("refuses a balance-moving topic in the allowlist and an invalid contract id", () => {
    expect(
      () =>
        new PolicyAwareExactStellarScheme([signer], {
          policyEventTopics: ["transfer"],
        }),
    ).toThrow(/balance-moving/);
    expect(
      () =>
        new PolicyAwareExactStellarScheme([signer], {
          policyContracts: ["not-a-contract"],
        }),
    ).toThrow(/not a Stellar contract address/);
  });
});

describe("readPolicyAwareOptions", () => {
  it("reads public options and does not copy secret keys into the result", () => {
    const secret = "SSECRETVALUEPLACEHOLDERNOTAREALKEY";
    const options = readPolicyAwareOptions({
      FACILITATOR_SECRET_KEY: secret,
      PAYER_SECRET_KEY: secret,
      POLICY_CONTRACT_IDS: `${POLICY}, ${POLICY}`,
      POLICY_EVENT_TOPICS: "spending_limit_enforced, simple_enforced",
      FEE_PROFILE: "Cold",
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      WARM_FEE_CAP_STROOPS: "400000",
    });
    expect(JSON.stringify(options)).not.toContain(secret);
    expect(JSON.stringify(options)).not.toContain("FACILITATOR_SECRET_KEY");
    expect(options.policyContracts).toEqual([POLICY]);
    expect(options.policyEventTopics).toEqual(["spending_limit_enforced", "simple_enforced"]);
    expect(options.feeProfile).toBe("cold");
    expect(options.rpcConfig).toEqual({ url: "https://soroban-testnet.stellar.org" });
    expect(options.warmCapStroops).toBe(400_000);
  });

  it("rejects an http RPC URL, a bad profile, and a balance-moving topic", () => {
    expect(() => readPolicyAwareOptions({ STELLAR_RPC_URL: "http://rpc.example" })).toThrow(
      /https/,
    );
    expect(() => readPolicyAwareOptions({ FEE_PROFILE: "hot" })).toThrow(/FEE_PROFILE/);
    expect(() => readPolicyAwareOptions({ POLICY_EVENT_TOPICS: "mint" })).toThrow(
      /balance-moving/,
    );
    expect(() => readPolicyAwareOptions({ WARM_FEE_CAP_STROOPS: "nope" })).toThrow(
      /WARM_FEE_CAP_STROOPS/,
    );
  });
});
