/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { estimateFeeFromSimulation } from "../src/fee.js";

describe("estimateFeeFromSimulation", () => {
  it("classifies the 2026-10-26 cold payment by its rent, not by the 5.71M band", () => {
    const estimate = estimateFeeFromSimulation({
      minResourceFee: 369_688,
      inclusionFeeStroops: 100,
      rentStroops: 311_460,
    });
    expect(estimate).toEqual({
      class: "cold",
      simulatedStroops: 369_788,
      recommendedCeiling: 6_500_000,
    });
  });

  it("classifies the 2026-10-26 warm payment", () => {
    const estimate = estimateFeeFromSimulation({
      minResourceFee: 58_228,
      inclusionFeeStroops: 100,
      rentStroops: 0,
    });
    expect(estimate).toEqual({
      class: "warm",
      simulatedStroops: 58_328,
      recommendedCeiling: 500_000,
    });
  });

  it("keeps the older 324,039 warm observation warm when rent is zero", () => {
    const estimate = estimateFeeFromSimulation({
      minResourceFee: 323_939,
      inclusionFeeStroops: 100,
      rentStroops: 0,
    });
    expect(estimate.class).toBe("warm");
    expect(estimate.simulatedStroops).toBe(324_039);
    expect(estimate.recommendedCeiling).toBe(500_000);
  });

  it("classifies a 5.71M simulation as cold even without a rent split", () => {
    const estimate = estimateFeeFromSimulation({
      minResourceFee: 5_709_900,
      inclusionFeeStroops: 100,
    });
    expect(estimate.class).toBe("cold");
    expect(estimate.simulatedStroops).toBe(5_710_000);
    expect(estimate.recommendedCeiling).toBe(6_500_000);
  });

  it("raises the ceiling above the profile cap when the simulation exceeds it", () => {
    const estimate = estimateFeeFromSimulation({
      minResourceFee: 7_000_000,
      inclusionFeeStroops: 100,
    });
    expect(estimate.class).toBe("cold");
    expect(estimate.recommendedCeiling).toBe(Math.ceil((7_000_100 * 5) / 4));
  });
});
