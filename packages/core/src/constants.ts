/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

/** `@x402/stellar` 2.28.x default. A smart-account `__check_auth` exceeds it. */
export const REFERENCE_MAX_TRANSACTION_FEE_STROOPS = 50_000;

/**
 * Warm smart-account payments measured about 310,000–319,000 stroops.
 * x402#3515 recorded a simulation-derived settlement fee of 324,039 stroops
 * (`minResourceFee` 323,939 plus the 100-stroop inclusion buffer).
 */
export const WARM_FEE_MEASURED_MIN_STROOPS = 310_000;
export const WARM_FEE_MEASURED_STROOPS = 319_000;
export const WARM_FEE_OBSERVED_SETTLEMENT_STROOPS = 324_039;

/** Cold (first-touch TTL rent) smart-account payments measured about 5.71M stroops. */
export const COLD_FEE_MEASURED_STROOPS = 5_710_000;

/**
 * Default warm ceiling. Above the 324,039-stroop observation and the 310–319k
 * band, and far below a cold rent payment.
 */
export const DEFAULT_WARM_FEE_CAP_STROOPS = 500_000;

/** Default cold ceiling. Above the 5.71M-stroop first-touch measurement. */
export const DEFAULT_COLD_FEE_CAP_STROOPS = 6_500_000;

/**
 * SEP-41 topics that move or authorize token balances. An allowlisted policy
 * contract cannot make these events acceptable.
 */
export const BALANCE_MOVING_TOPICS = [
  "transfer",
  "mint",
  "burn",
  "clawback",
  "approve",
  "set_authorized",
] as const;

export type BalanceMovingTopic = (typeof BALANCE_MOVING_TOPICS)[number];

export const BALANCE_MOVING_TOPIC_SET: ReadonlySet<string> = new Set(
  BALANCE_MOVING_TOPICS,
);

export const INVALID_REASON = {
  rejectedEvent: "invalid_exact_stellar_payload_rejected_event",
  missingContractId: "invalid_exact_stellar_payload_event_missing_contract_id",
  eventNotTransfer: "invalid_exact_stellar_payload_event_not_transfer",
  wrongAsset: "invalid_exact_stellar_payload_event_wrong_asset",
  wrongFrom: "invalid_exact_stellar_payload_event_wrong_from",
  wrongTo: "invalid_exact_stellar_payload_event_wrong_to",
  wrongAmount: "invalid_exact_stellar_payload_event_wrong_amount",
  feeExceedsMaximum: "invalid_exact_stellar_payload_fee_exceeds_maximum",
} as const;
