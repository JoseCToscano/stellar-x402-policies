/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

export { authDigest, authDigestPreimage, signAuthEntry } from "./auth.js";
export { estimateFeeFromSimulation, INCLUSION_FEE_STROOPS } from "./fee.js";
export type { FeeSimulation } from "./fee.js";
export { SpendingPolicyKit } from "./kit.js";
export type { PayOptions, SpendingPolicyKitOptions } from "./kit.js";
export { CONTRACT_REASONS, precheckFromReport, reasonFromSimulationError } from "./precheck.js";
export { Ed25519Signer, WebAuthnSigner, webAuthnTestDouble } from "./signers.js";
export type { AgentSigner } from "./signers.js";
export { compileTemplate } from "./templates.js";
export type {
  CompiledPolicy,
  CompiledRule,
  CompiledTemplate,
  TemplateDocument,
  TemplatePolicy,
} from "./templates.js";
export { PayRefused } from "./types.js";
export type {
  AccountReport,
  AccountRule,
  ExactRequirements,
  FeeEstimate,
  MerchantRemaining,
  PayReceipt,
  PrecheckReason,
  PrecheckResult,
  RuleSigner,
} from "./types.js";
