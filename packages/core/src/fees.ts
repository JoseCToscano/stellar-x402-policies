/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COLD_FEE_MEASURED_STROOPS,
  DEFAULT_COLD_FEE_CAP_STROOPS,
  DEFAULT_WARM_FEE_CAP_STROOPS,
  WARM_FEE_MEASURED_STROOPS,
} from "./constants.js";

export type FeeProfileName = "warm" | "cold";

export interface ResolvedFeeProfile {
  name: FeeProfileName;
  /** Documented measurement for this profile, in stroops. */
  measuredStroops: number;
  /** Safety ceiling passed to ExactStellarScheme as `maxTransactionFeeStroops`. */
  capStroops: number;
  capSource: "profile" | "override";
  warmCapStroops: number;
  coldCapStroops: number;
}

export interface FeeProfileConfig {
  profile?: FeeProfileName;
  warmCapStroops?: number;
  coldCapStroops?: number;
  /**
   * Replaces the profile cap. The reference scheme compares this value with
   * `minResourceFee + inclusionFeeStroops`.
   */
  maxTransactionFeeStroops?: number;
}

export interface FeeDecision {
  accepted: boolean;
  settlementFeeStroops: number;
  capStroops: number;
  profile: FeeProfileName;
  reason?: "fee_invalid" | "fee_exceeds_cap";
}

export function assertStroops(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer number of stroops`);
  }
  return value;
}

export function parseFeeProfileName(value: string | undefined): FeeProfileName | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const name = value.trim().toLowerCase();
  if (name === "warm" || name === "cold") {
    return name;
  }
  throw new Error('FEE_PROFILE must be "warm" or "cold"');
}

/**
 * Resolves the facilitator fee ceiling for a warm or cold smart account.
 * Warm is the default. Cold covers first-touch TTL rent and spends more of
 * the facilitator's XLM, so operators select it explicitly.
 */
export function resolveFeeProfile(config: FeeProfileConfig = {}): ResolvedFeeProfile {
  const name = config.profile ?? "warm";
  if (name !== "warm" && name !== "cold") {
    throw new Error(`Unknown fee profile "${String(name)}". Expected "warm" or "cold".`);
  }

  const warmCapStroops = assertStroops(
    "warmCapStroops",
    config.warmCapStroops ?? DEFAULT_WARM_FEE_CAP_STROOPS,
  );
  const coldCapStroops = assertStroops(
    "coldCapStroops",
    config.coldCapStroops ?? DEFAULT_COLD_FEE_CAP_STROOPS,
  );
  const profileCap = name === "warm" ? warmCapStroops : coldCapStroops;
  const override = config.maxTransactionFeeStroops;
  const capStroops =
    override === undefined ? profileCap : assertStroops("maxTransactionFeeStroops", override);

  return {
    name,
    measuredStroops: name === "warm" ? WARM_FEE_MEASURED_STROOPS : COLD_FEE_MEASURED_STROOPS,
    capStroops,
    capSource: override === undefined ? "profile" : "override",
    warmCapStroops,
    coldCapStroops,
  };
}

/**
 * Decides whether a simulation-derived settlement fee (`minResourceFee +
 * inclusionFee`) is inside the selected cap. This is the same comparison
 * `ExactStellarScheme` performs against `maxTransactionFeeStroops`.
 */
export function evaluateSettlementFee(
  settlementFeeStroops: number,
  profile: Pick<ResolvedFeeProfile, "name" | "capStroops">,
): FeeDecision {
  if (!Number.isSafeInteger(settlementFeeStroops) || settlementFeeStroops < 0) {
    return {
      accepted: false,
      settlementFeeStroops,
      capStroops: profile.capStroops,
      profile: profile.name,
      reason: "fee_invalid",
    };
  }
  if (settlementFeeStroops > profile.capStroops) {
    return {
      accepted: false,
      settlementFeeStroops,
      capStroops: profile.capStroops,
      profile: profile.name,
      reason: "fee_exceeds_cap",
    };
  }
  return {
    accepted: true,
    settlementFeeStroops,
    capStroops: profile.capStroops,
    profile: profile.name,
  };
}
