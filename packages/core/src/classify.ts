/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { BALANCE_MOVING_TOPIC_SET, INVALID_REASON } from "./constants.js";

export type EventClassification = "transfer" | "allowed_policy" | "rejected" | "ignored";

/**
 * Normalized Soroban diagnostic event. `type` is the XDR enum name
 * (`contract`, `system`, or `diagnostic`). Topics and data are native values
 * from `scValToNative`.
 */
export interface SimulationEventView {
  type: string;
  contractId: string | null;
  topics: readonly unknown[];
  data: unknown;
}

export interface ClassifyContext {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
  /** Contract ids whose non-balance-moving events may be ignored. */
  policyContracts: ReadonlySet<string>;
  /**
   * When non-empty, an allowlisted contract event must also use one of these
   * first-topic symbols. Balance-moving symbols are never accepted here.
   */
  policyEventTopics?: ReadonlySet<string>;
}

export interface ClassifiedSimulationEvent {
  index: number;
  classification: EventClassification;
  contractId: string | null;
  topic: string | null;
  reason?: string;
  invalidReason?: string;
}

export interface ClassificationSummary {
  events: ClassifiedSimulationEvent[];
  transferIndexes: number[];
  allowedPolicyIndexes: number[];
  rejected: ClassifiedSimulationEvent[];
}

function topicSymbol(topics: readonly unknown[]): string | null {
  const first = topics[0];
  return typeof first === "string" ? first : null;
}

function asAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function isBalanceMoving(symbol: string): boolean {
  return BALANCE_MOVING_TOPIC_SET.has(symbol.toLowerCase());
}

function rejected(
  index: number,
  contractId: string | null,
  topic: string | null,
  reason: string,
  invalidReason: string,
): ClassifiedSimulationEvent {
  return {
    index,
    classification: "rejected",
    contractId,
    topic,
    reason,
    invalidReason,
  };
}

function classifyOne(
  index: number,
  event: SimulationEventView,
  context: ClassifyContext,
): ClassifiedSimulationEvent {
  if (event.type !== "contract") {
    return {
      index,
      classification: "ignored",
      contractId: event.contractId,
      topic: topicSymbol(event.topics),
    };
  }

  const topic = topicSymbol(event.topics);
  if (event.contractId === null) {
    return rejected(
      index,
      null,
      topic,
      "missing_contract_id",
      INVALID_REASON.missingContractId,
    );
  }

  const contractId = event.contractId;

  if (topic === "transfer") {
    if (contractId !== context.asset) {
      return rejected(
        index,
        contractId,
        topic,
        "transfer_wrong_asset",
        INVALID_REASON.wrongAsset,
      );
    }
    const from = event.topics[1];
    const to = event.topics[2];
    if (event.topics.length < 3 || typeof from !== "string" || typeof to !== "string") {
      return rejected(
        index,
        contractId,
        topic,
        "transfer_malformed",
        INVALID_REASON.eventNotTransfer,
      );
    }
    if (from !== context.from) {
      return rejected(index, contractId, topic, "transfer_mismatch_from", INVALID_REASON.wrongFrom);
    }
    if (to !== context.to) {
      return rejected(index, contractId, topic, "transfer_mismatch_to", INVALID_REASON.wrongTo);
    }
    const amount = asAmount(event.data);
    if (amount === null) {
      return rejected(
        index,
        contractId,
        topic,
        "transfer_malformed",
        INVALID_REASON.eventNotTransfer,
      );
    }
    if (amount !== context.amount) {
      return rejected(
        index,
        contractId,
        topic,
        "transfer_mismatch_amount",
        INVALID_REASON.wrongAmount,
      );
    }
    return { index, classification: "transfer", contractId, topic };
  }

  if (topic !== null && isBalanceMoving(topic)) {
    return rejected(
      index,
      contractId,
      topic,
      "balance_moving_topic",
      INVALID_REASON.rejectedEvent,
    );
  }

  if (contractId === context.asset) {
    return rejected(
      index,
      contractId,
      topic,
      "unexpected_asset_event",
      INVALID_REASON.rejectedEvent,
    );
  }

  if (!context.policyContracts.has(contractId)) {
    return rejected(
      index,
      contractId,
      topic,
      "emitter_not_allowlisted",
      INVALID_REASON.rejectedEvent,
    );
  }

  const topicAllowlist = context.policyEventTopics;
  if (topicAllowlist !== undefined && topicAllowlist.size > 0) {
    if (topic === null || !topicAllowlist.has(topic)) {
      return rejected(
        index,
        contractId,
        topic,
        "topic_not_allowlisted",
        INVALID_REASON.rejectedEvent,
      );
    }
  }

  return { index, classification: "allowed_policy", contractId, topic };
}

/**
 * Classifies each simulation event as the payment transfer, an allowlisted
 * policy event, a rejected event, or an ignored non-contract event.
 *
 * The payment transfer is the SEP-41 `transfer` from `asset` with the expected
 * sender, recipient, and amount. Every other balance-moving topic is rejected,
 * including when the emitter is allowlisted. Other topics are allowed only
 * from `policyContracts`, and only when `policyEventTopics` is empty or
 * contains the topic.
 */
export function classifySimulationEvents(
  events: readonly SimulationEventView[],
  context: ClassifyContext,
): ClassificationSummary {
  const classified = events.map((event, index) => classifyOne(index, event, context));
  return {
    events: classified,
    transferIndexes: classified
      .filter((event) => event.classification === "transfer")
      .map((event) => event.index),
    allowedPolicyIndexes: classified
      .filter((event) => event.classification === "allowed_policy")
      .map((event) => event.index),
    rejected: classified.filter((event) => event.classification === "rejected"),
  };
}

export function rejectionMessage(event: ClassifiedSimulationEvent): string {
  const topic = event.topic ?? "(no topic)";
  const contract = event.contractId ?? "(no contract)";
  const reason = event.reason ?? "rejected";
  return `rejected ${topic} from ${contract} (${reason})`;
}
