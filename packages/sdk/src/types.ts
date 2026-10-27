/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

export type PrecheckReason =
  | "merchant_not_allowed"
  | "over_cap"
  | "over_per_tx"
  | "expired"
  | "history_full";

export type PrecheckResult =
  | { ok: true }
  | { ok: false; reason: PrecheckReason; needsOwnerApproval: true };

export interface ExactRequirements {
  scheme?: string;
  network?: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface RuleSigner {
  kind: "delegated" | "external";
  address: string;
  verifier?: string;
}

export interface AccountRule {
  id: number;
  type: string;
  contract?: string;
  name: string;
  validUntil?: number;
  signers: RuleSigner[];
  policies: string[];
}

export interface MerchantRemaining {
  merchant: string;
  remaining: bigint;
  allowed: boolean;
}

export interface AccountReport {
  address: string;
  ledger: number;
  rules: AccountRule[];
  /** Remaining allowance per merchant, from `get_remaining`. */
  merchants: MerchantRemaining[];
  /** History entries / capacity when a policy reported them. 815 is full. */
  historyFill?: { entries: number; capacity: number };
}

export interface FeeEstimate {
  class: "warm" | "cold";
  simulatedStroops: number;
  recommendedCeiling: number;
}

export interface PayReceipt {
  txHash: string;
  feeCharged: number;
}

export class PayRefused extends Error {
  readonly reason: PrecheckReason;
  readonly needsOwnerApproval = true as const;

  constructor(reason: PrecheckReason) {
    super(`payment needs owner approval: ${reason}`);
    this.name = "PayRefused";
    this.reason = reason;
  }
}
