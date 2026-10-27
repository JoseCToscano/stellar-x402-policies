/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  BALANCE_MOVING_TOPICS,
  COLD_FEE_MEASURED_STROOPS,
  DEFAULT_COLD_FEE_CAP_STROOPS,
  DEFAULT_WARM_FEE_CAP_STROOPS,
  INVALID_REASON,
  REFERENCE_MAX_TRANSACTION_FEE_STROOPS,
  WARM_FEE_MEASURED_MIN_STROOPS,
  WARM_FEE_MEASURED_STROOPS,
  WARM_FEE_OBSERVED_SETTLEMENT_STROOPS,
} from "./constants.js";
export type { BalanceMovingTopic } from "./constants.js";

export { classifySimulationEvents, rejectionMessage } from "./classify.js";
export {
  contractAddressBase,
  decodeMuxedContract,
  encodeMuxedContract,
  sameTransferRecipient,
} from "./muxed.js";
export type { MuxedContract } from "./muxed.js";
export type {
  ClassifiedSimulationEvent,
  ClassificationSummary,
  ClassifyContext,
  EventClassification,
  SimulationEventView,
} from "./classify.js";

export { readPolicyAwareOptions } from "./env.js";

export {
  assertStroops,
  evaluateSettlementFee,
  parseFeeProfileName,
  resolveFeeProfile,
} from "./fees.js";
export type { FeeDecision, FeeProfileConfig, FeeProfileName, ResolvedFeeProfile } from "./fees.js";

export { parseDiagnosticEvent } from "./parse-event.js";
export { normalizePolicyContracts, normalizePolicyEventTopics, parseCsv } from "./policy-config.js";

export { filterSimulationEvents, PolicyAwareExactStellarScheme } from "./scheme.js";
export type { PolicyAwareSchemeOptions } from "./scheme.js";
