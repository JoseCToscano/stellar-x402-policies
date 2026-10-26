/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { classifySimulationEvents, type SimulationEventView } from "../src/classify.js";
import { INVALID_REASON } from "../src/constants.js";
import { ASSET, FROM, OTHER, POLICY, TO } from "./fixtures.js";

const AMOUNT = 1000n;

function transfer(overrides: Partial<SimulationEventView> = {}): SimulationEventView {
  return {
    type: "contract",
    contractId: ASSET,
    topics: ["transfer", FROM, TO],
    data: AMOUNT,
    ...overrides,
  };
}

function policy(
  topic = "spending_limit_enforced",
  contractId: string | null = POLICY,
): SimulationEventView {
  return {
    type: "contract",
    contractId,
    topics: [topic, FROM],
    data: { window: 1 },
  };
}

function classify(
  events: SimulationEventView[],
  options: { contracts?: string[]; topics?: string[] } = {},
) {
  return classifySimulationEvents(events, {
    asset: ASSET,
    from: FROM,
    to: TO,
    amount: AMOUNT,
    policyContracts: new Set(options.contracts ?? [POLICY]),
    policyEventTopics: new Set(options.topics ?? []),
  });
}

describe("classifySimulationEvents", () => {
  it("accepts one exact transfer and an allowlisted policy event ahead of it", () => {
    const summary = classify([policy(), transfer()]);
    expect(summary.events.map((event) => event.classification)).toEqual([
      "allowed_policy",
      "transfer",
    ]);
    expect(summary.rejected).toEqual([]);
    expect(summary.transferIndexes).toEqual([1]);
  });

  it("accepts simple_enforced from an allowlisted contract when no topic filter is set", () => {
    const summary = classify([policy("simple_enforced"), transfer()]);
    expect(summary.events[0]?.classification).toBe("allowed_policy");
  });

  it("rejects a policy topic that is outside the topic allowlist", () => {
    const summary = classify([policy("simple_enforced"), transfer()], {
      topics: ["spending_limit_enforced"],
    });
    expect(summary.rejected[0]).toMatchObject({
      reason: "topic_not_allowlisted",
      invalidReason: INVALID_REASON.rejectedEvent,
      topic: "simple_enforced",
    });
  });

  it("rejects balance-moving topics from an allowlisted policy contract", () => {
    for (const topic of ["mint", "burn", "clawback", "approve", "set_authorized", "MINT"]) {
      const summary = classify([policy(topic), transfer()]);
      expect(summary.rejected[0]?.reason, topic).toBe("balance_moving_topic");
    }
  });

  it("rejects a transfer emitted by the policy contract", () => {
    const summary = classify([
      {
        type: "contract",
        contractId: POLICY,
        topics: ["transfer", FROM, TO],
        data: AMOUNT,
      },
      transfer(),
    ]);
    expect(summary.rejected[0]).toMatchObject({
      reason: "transfer_wrong_asset",
      invalidReason: INVALID_REASON.wrongAsset,
    });
  });

  it("rejects an informational event from the payment asset", () => {
    const summary = classify([policy("spending_limit_enforced", ASSET), transfer()]);
    expect(summary.rejected[0]?.reason).toBe("unexpected_asset_event");
  });

  it("rejects an event from a contract that is not allowlisted", () => {
    const summary = classify([policy("spending_limit_enforced", OTHER), transfer()]);
    expect(summary.rejected[0]).toMatchObject({
      reason: "emitter_not_allowlisted",
      contractId: OTHER,
    });
  });

  it("rejects a contract event with no contract id", () => {
    const summary = classify([policy("spending_limit_enforced", null), transfer()]);
    expect(summary.rejected[0]).toMatchObject({
      reason: "missing_contract_id",
      invalidReason: INVALID_REASON.missingContractId,
    });
  });

  it("ignores non-contract events", () => {
    const summary = classify([
      { type: "diagnostic", contractId: null, topics: ["mint", FROM, TO], data: AMOUNT },
      transfer(),
    ]);
    expect(summary.events.map((event) => event.classification)).toEqual(["ignored", "transfer"]);
  });

  it("rejects a transfer whose sender, recipient, or amount does not match", () => {
    expect(classify([transfer({ topics: ["transfer", OTHER, TO] })]).rejected[0]?.reason).toBe(
      "transfer_mismatch_from",
    );
    expect(classify([transfer({ topics: ["transfer", FROM, OTHER] })]).rejected[0]?.reason).toBe(
      "transfer_mismatch_to",
    );
    expect(classify([transfer({ data: AMOUNT + 1n })]).rejected[0]).toMatchObject({
      reason: "transfer_mismatch_amount",
      invalidReason: INVALID_REASON.wrongAmount,
    });
  });

  it("rejects a short or non-symbol transfer from the asset", () => {
    expect(
      classify([transfer({ topics: ["transfer", FROM] })]).rejected[0]?.reason,
    ).toBe("transfer_malformed");
    expect(
      classify([
        transfer({ topics: [1, FROM, TO] }),
      ]).rejected[0]?.invalidReason,
    ).toBe(INVALID_REASON.rejectedEvent);
  });

  it("does not treat a capitalized Transfer as the payment transfer", () => {
    const summary = classify([
      {
        type: "contract",
        contractId: ASSET,
        topics: ["Transfer", FROM, TO],
        data: AMOUNT,
      },
    ]);
    expect(summary.transferIndexes).toEqual([]);
    expect(summary.rejected[0]?.reason).toBe("balance_moving_topic");
  });

  it("collects two matching transfers so the reference scan can reject the duplicate", () => {
    const summary = classify([transfer(), transfer()]);
    expect(summary.transferIndexes).toEqual([0, 1]);
    expect(summary.rejected).toEqual([]);
  });
});
