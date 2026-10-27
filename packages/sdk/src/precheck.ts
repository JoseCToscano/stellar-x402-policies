/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AccountReport, ExactRequirements, PrecheckReason, PrecheckResult } from "./types.js";

/** Contract error codes this kit maps onto a precheck reason. */
export const CONTRACT_REASONS: Readonly<Record<number, PrecheckReason>> = {
  3401: "merchant_not_allowed",
  3402: "over_cap",
  3403: "over_per_tx",
  3407: "history_full",
  3221: "over_cap",
  3224: "history_full",
  3501: "over_cap",
  3502: "over_per_tx",
};

const HISTORY_CAPACITY = 815;

export function reasonFromSimulationError(error: string): PrecheckReason | undefined {
  const match = /#(\d+)/.exec(error);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return CONTRACT_REASONS[Number(match[1])];
}

export function ruleForAsset(report: AccountReport, asset: string) {
  return report.rules.find((rule) => rule.type === "CallContract" && rule.contract === asset);
}

/**
 * Local checks that do not need a transfer simulation: expiry, a merchant
 * the policy already rejected, a known remaining balance, and a full history.
 */
export function precheckFromReport(
  report: AccountReport,
  requirements: ExactRequirements,
  ledger: number,
): PrecheckResult | undefined {
  const rule = ruleForAsset(report, requirements.asset);
  if (rule?.validUntil !== undefined && ledger > rule.validUntil) {
    return { ok: false, reason: "expired", needsOwnerApproval: true };
  }
  const watched = report.merchants.find((merchant) => merchant.merchant === requirements.payTo);
  if (watched !== undefined && !watched.allowed) {
    return { ok: false, reason: "merchant_not_allowed", needsOwnerApproval: true };
  }
  if (watched?.allowed === true && BigInt(requirements.amount) > watched.remaining) {
    return { ok: false, reason: "over_cap", needsOwnerApproval: true };
  }
  const fill = report.historyFill;
  if (fill !== undefined && fill.entries >= (fill.capacity || HISTORY_CAPACITY)) {
    return { ok: false, reason: "history_full", needsOwnerApproval: true };
  }
  return undefined;
}
