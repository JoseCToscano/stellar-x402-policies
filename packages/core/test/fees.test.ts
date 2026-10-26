/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import {
  COLD_FEE_MEASURED_STROOPS,
  DEFAULT_COLD_FEE_CAP_STROOPS,
  DEFAULT_WARM_FEE_CAP_STROOPS,
  REFERENCE_MAX_TRANSACTION_FEE_STROOPS,
  WARM_FEE_MEASURED_MIN_STROOPS,
  WARM_FEE_MEASURED_STROOPS,
  WARM_FEE_OBSERVED_SETTLEMENT_STROOPS,
} from "../src/constants.js";
import { evaluateSettlementFee, resolveFeeProfile } from "../src/fees.js";

describe("fee profiles", () => {
  it("uses a warm cap above the measured warm band and the 324,039 observation", () => {
    const warm = resolveFeeProfile();
    expect(warm.name).toBe("warm");
    expect(warm.capStroops).toBe(DEFAULT_WARM_FEE_CAP_STROOPS);
    expect(warm.capSource).toBe("profile");
    for (const fee of [
      WARM_FEE_MEASURED_MIN_STROOPS,
      WARM_FEE_MEASURED_STROOPS,
      WARM_FEE_OBSERVED_SETTLEMENT_STROOPS,
    ]) {
      expect(evaluateSettlementFee(fee, warm).accepted).toBe(true);
    }
  });

  it("rejects a cold measurement on the warm cap and accepts it on the cold cap", () => {
    const warm = resolveFeeProfile({ profile: "warm" });
    const cold = resolveFeeProfile({ profile: "cold" });
    expect(cold.capStroops).toBe(DEFAULT_COLD_FEE_CAP_STROOPS);
    expect(cold.measuredStroops).toBe(COLD_FEE_MEASURED_STROOPS);
    expect(evaluateSettlementFee(COLD_FEE_MEASURED_STROOPS, warm)).toMatchObject({
      accepted: false,
      reason: "fee_exceeds_cap",
    });
    expect(evaluateSettlementFee(COLD_FEE_MEASURED_STROOPS, cold).accepted).toBe(true);
    expect(evaluateSettlementFee(cold.capStroops + 1, cold)).toMatchObject({
      accepted: false,
      reason: "fee_exceeds_cap",
    });
  });

  it("rejects the warm smart-account fee at the reference 50,000 stroop ceiling", () => {
    const reference = {
      name: "warm" as const,
      capStroops: REFERENCE_MAX_TRANSACTION_FEE_STROOPS,
    };
    expect(REFERENCE_MAX_TRANSACTION_FEE_STROOPS).toBe(50_000);
    expect(evaluateSettlementFee(WARM_FEE_MEASURED_STROOPS, reference)).toMatchObject({
      accepted: false,
      reason: "fee_exceeds_cap",
    });
    expect(evaluateSettlementFee(WARM_FEE_OBSERVED_SETTLEMENT_STROOPS, reference).accepted).toBe(
      false,
    );
  });

  it("accepts an exact cap and rejects one stroop above it", () => {
    const profile = resolveFeeProfile({ profile: "warm", warmCapStroops: 319_000 });
    expect(evaluateSettlementFee(319_000, profile).accepted).toBe(true);
    expect(evaluateSettlementFee(319_001, profile).accepted).toBe(false);
  });

  it("lets an explicit ceiling replace the profile cap", () => {
    const profile = resolveFeeProfile({
      profile: "cold",
      maxTransactionFeeStroops: 42_000,
    });
    expect(profile.capSource).toBe("override");
    expect(profile.capStroops).toBe(42_000);
    expect(profile.name).toBe("cold");
    expect(evaluateSettlementFee(COLD_FEE_MEASURED_STROOPS, profile).accepted).toBe(false);
  });

  it("accepts a custom cold cap that still covers the 5.71M measurement", () => {
    const profile = resolveFeeProfile({ profile: "cold", coldCapStroops: 5_800_000 });
    expect(evaluateSettlementFee(COLD_FEE_MEASURED_STROOPS, profile).accepted).toBe(true);
    expect(evaluateSettlementFee(5_800_001, profile).accepted).toBe(false);
  });

  it("rejects a non-integer or negative settlement fee", () => {
    const warm = resolveFeeProfile();
    expect(evaluateSettlementFee(1.5, warm).reason).toBe("fee_invalid");
    expect(evaluateSettlementFee(-1, warm).reason).toBe("fee_invalid");
    expect(evaluateSettlementFee(Number.NaN, warm).reason).toBe("fee_invalid");
  });

  it("rejects an unknown profile and a non-positive cap", () => {
    expect(() => resolveFeeProfile({ profile: "hot" as "warm" })).toThrow(/Unknown fee profile/);
    expect(() => resolveFeeProfile({ warmCapStroops: 0 })).toThrow(/warmCapStroops/);
    expect(() => resolveFeeProfile({ coldCapStroops: -5 })).toThrow(/coldCapStroops/);
    expect(() => resolveFeeProfile({ maxTransactionFeeStroops: 1.2 })).toThrow(
      /maxTransactionFeeStroops/,
    );
  });
});
