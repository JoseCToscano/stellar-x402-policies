/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { xdr } from "@stellar/stellar-sdk";
import type { Network, VerifyResponse } from "@x402/core/types";
import type { FacilitatorStellarSigner, RpcConfig } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import {
  classifySimulationEvents,
  rejectionMessage,
  type SimulationEventView,
} from "./classify.js";
import { INVALID_REASON } from "./constants.js";
import type { FeeProfileName, ResolvedFeeProfile } from "./fees.js";
import { resolveFeeProfile } from "./fees.js";
import { parseDiagnosticEvent } from "./parse-event.js";
import { normalizePolicyContracts, normalizePolicyEventTopics } from "./policy-config.js";

export interface PolicyAwareSchemeOptions {
  rpcConfig?: RpcConfig;
  areFeesSponsored?: boolean;
  inclusionFeeStroops?: number;
  selectSigner?: (addresses: readonly string[]) => string;
  feeBumpSigner?: FacilitatorStellarSigner;
  /** Contract ids allowed to emit non-balance-moving policy events. */
  policyContracts?: readonly string[];
  /**
   * Optional topic allowlist. Empty means any non-balance-moving topic from
   * `policyContracts` is accepted.
   */
  policyEventTopics?: readonly string[];
  feeProfile?: FeeProfileName;
  warmCapStroops?: number;
  coldCapStroops?: number;
  maxTransactionFeeStroops?: number;
  /**
   * Accept a CAP-84 W `payTo` when the simulated transfer's `to` is that
   * address's base contract. Default false until Protocol 30 is live.
   */
  matchMuxedContract?: boolean;
}

interface ReferenceEventCheck {
  validateSimulationEvents(
    events: xdr.DiagnosticEvent[],
    fromAddress: string,
    toAddress: string,
    expectedAmount: bigint,
    expectedAsset: string,
  ): VerifyResponse | undefined;
}

const REFERENCE_EVENT_METHOD = "validateSimulationEvents";

function invalid(
  reason: string,
  payer: string | undefined,
  message: string,
): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer, invalidMessage: message };
}

/**
 * Drops allowlisted policy events, then runs the reference transfer check on
 * what remains. Rejected events return before the reference scan so a policy
 * event is not reported as `event_not_transfer`.
 */
export function filterSimulationEvents(
  original: ReferenceEventCheck["validateSimulationEvents"],
  host: ReferenceEventCheck,
  events: readonly xdr.DiagnosticEvent[] | undefined,
  fromAddress: string,
  toAddress: string,
  expectedAmount: bigint,
  expectedAsset: string,
  policyContracts: ReadonlySet<string>,
  policyEventTopics: ReadonlySet<string>,
  matchMuxedContract = false,
): VerifyResponse | undefined {
  const list = Array.isArray(events) ? events : [];
  const views: SimulationEventView[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const diagnostic = list[index];
    if (diagnostic === undefined) {
      return invalid(
        INVALID_REASON.rejectedEvent,
        fromAddress,
        `rejected unparseable event at index ${index} (missing)`,
      );
    }
    try {
      views.push(parseDiagnosticEvent(diagnostic));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return invalid(
        INVALID_REASON.rejectedEvent,
        fromAddress,
        `rejected unparseable event at index ${index} (${detail.slice(0, 200)})`,
      );
    }
  }

  const summary = classifySimulationEvents(views, {
    asset: expectedAsset,
    from: fromAddress,
    to: toAddress,
    amount: expectedAmount,
    policyContracts,
    policyEventTopics,
    matchMuxedContract,
  });
  const firstRejected = summary.rejected[0];
  if (firstRejected !== undefined) {
    return invalid(
      firstRejected.invalidReason ?? INVALID_REASON.rejectedEvent,
      fromAddress,
      rejectionMessage(firstRejected),
    );
  }

  const retained: xdr.DiagnosticEvent[] = [];
  for (const classified of summary.events) {
    if (classified.classification === "allowed_policy") {
      continue;
    }
    const diagnostic = list[classified.index];
    if (diagnostic !== undefined) {
      retained.push(diagnostic);
    }
  }
  return original.call(host, retained, fromAddress, toAddress, expectedAmount, expectedAsset);
}

function installPolicyEventFilter(
  scheme: PolicyAwareExactStellarScheme,
  policyContracts: ReadonlySet<string>,
  policyEventTopics: ReadonlySet<string>,
  matchMuxedContract: boolean,
): void {
  const host = scheme as unknown as ReferenceEventCheck;
  const original = host[REFERENCE_EVENT_METHOD];
  if (typeof original !== "function") {
    throw new Error(
      "ExactStellarScheme.validateSimulationEvents is missing. stellar-x402-policies supports @x402/stellar 2.28.x.",
    );
  }
  host.validateSimulationEvents = function policyAwareValidateSimulationEvents(
    events,
    fromAddress,
    toAddress,
    expectedAmount,
    expectedAsset,
  ) {
    return filterSimulationEvents(
      original,
      host,
      events,
      fromAddress,
      toAddress,
      expectedAmount,
      expectedAsset,
      policyContracts,
      policyEventTopics,
      matchMuxedContract,
    );
  };
}

/**
 * Exact Stellar facilitator scheme that accepts non-balance-moving events from
 * allowlisted policy contracts and raises the fee ceiling to a warm or cold
 * smart-account profile.
 *
 * Every other reference check stays in `ExactStellarScheme`: one matching
 * transfer, payer auth, no sub-invocations, and the simulation fee ceiling.
 * `@x402/stellar` 2.28.x keeps the event scan on a prototype method, so this
 * subclass replaces that method and then calls the original scan.
 */
export class PolicyAwareExactStellarScheme extends ExactStellarScheme {
  readonly feeProfile: ResolvedFeeProfile;
  readonly policyContracts: readonly string[];
  readonly policyEventTopics: readonly string[];
  readonly matchMuxedContract: boolean;

  constructor(signers: FacilitatorStellarSigner[], options: PolicyAwareSchemeOptions = {}) {
    const policyContracts = normalizePolicyContracts(options.policyContracts ?? []);
    const policyEventTopics = normalizePolicyEventTopics(options.policyEventTopics);
    const feeProfile = resolveFeeProfile({
      profile: options.feeProfile,
      warmCapStroops: options.warmCapStroops,
      coldCapStroops: options.coldCapStroops,
      maxTransactionFeeStroops: options.maxTransactionFeeStroops,
    });
    super(signers, {
      rpcConfig: options.rpcConfig,
      areFeesSponsored: options.areFeesSponsored,
      maxTransactionFeeStroops: feeProfile.capStroops,
      inclusionFeeStroops: options.inclusionFeeStroops,
      selectSigner: options.selectSigner,
      feeBumpSigner: options.feeBumpSigner,
    });
    this.feeProfile = feeProfile;
    this.policyContracts = policyContracts;
    this.policyEventTopics = policyEventTopics;
    this.matchMuxedContract = options.matchMuxedContract === true;
    installPolicyEventFilter(
      this,
      new Set(policyContracts),
      new Set(policyEventTopics),
      this.matchMuxedContract,
    );
  }

  override getExtra(network: Network): Record<string, unknown> | undefined {
    const extra = super.getExtra(network);
    return {
      ...extra,
      feeProfile: this.feeProfile.name,
      maxTransactionFeeStroops: this.maxTransactionFeeStroops,
      measuredFeeStroops: this.feeProfile.measuredStroops,
      policyEventContracts: [...this.policyContracts],
      policyEventTopics: [...this.policyEventTopics],
      matchMuxedContract: this.matchMuxedContract,
    };
  }
}
