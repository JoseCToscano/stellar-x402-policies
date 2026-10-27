/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COLD_FEE_MEASURED_STROOPS,
  DEFAULT_COLD_FEE_CAP_STROOPS,
  DEFAULT_WARM_FEE_CAP_STROOPS,
} from "stellar-x402-policies";

import type { FeeEstimate } from "./types.js";

/** Inclusion buffer the reference scheme adds to `minResourceFee`. */
export const INCLUSION_FEE_STROOPS = 100;

/**
 * A recorded Soroban simulation. `rentStroops` is the first-touch component
 * already inside `minResourceFee`. The 2026-10-26 cold payment simulated at
 * 369,788 stroops with about 311,460 stroops of rent. A warm total of 324,039
 * with no rent stays warm.
 */
export interface FeeSimulation {
  minResourceFee: number;
  inclusionFeeStroops?: number;
  rentStroops?: number;
  firstTouch?: boolean;
}

const BUFFER_NUMERATOR = 5;
const BUFFER_DENOMINATOR = 4;

export function estimateFeeFromSimulation(simulation: FeeSimulation): FeeEstimate {
  const inclusion = simulation.inclusionFeeStroops ?? INCLUSION_FEE_STROOPS;
  const simulatedStroops = simulation.minResourceFee + inclusion;
  const cold =
    simulation.firstTouch === true ||
    (simulation.rentStroops ?? 0) > 0 ||
    simulatedStroops >= COLD_FEE_MEASURED_STROOPS;
  const feeClass = cold ? "cold" : "warm";
  const cap = cold ? DEFAULT_COLD_FEE_CAP_STROOPS : DEFAULT_WARM_FEE_CAP_STROOPS;
  const recommendedCeiling =
    simulatedStroops > cap
      ? Math.ceil((simulatedStroops * BUFFER_NUMERATOR) / BUFFER_DENOMINATOR)
      : cap;
  return { class: feeClass, simulatedStroops, recommendedCeiling };
}
