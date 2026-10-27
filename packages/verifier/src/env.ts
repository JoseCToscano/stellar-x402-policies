/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RpcConfig } from "@x402/stellar";

import { parseFeeProfileName } from "./fees.js";
import {
  normalizePolicyContracts,
  normalizePolicyEventTopics,
  parseCsv,
} from "./policy-config.js";
import type { PolicyAwareSchemeOptions } from "./scheme.js";

function readOptionalStroops(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer number of stroops`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer number of stroops`);
  }
  return value;
}

function readRpcConfig(env: NodeJS.ProcessEnv): RpcConfig | undefined {
  const url = env.STELLAR_RPC_URL?.trim();
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  if (!url.startsWith("https://")) {
    throw new Error("STELLAR_RPC_URL must be an https URL");
  }
  return { url };
}

/**
 * Reads facilitator options from the environment. Secret keys are ignored;
 * callers pass signers separately.
 */
export function readPolicyAwareOptions(env: NodeJS.ProcessEnv): PolicyAwareSchemeOptions {
  const feeProfile = parseFeeProfileName(env.FEE_PROFILE);
  const rpcConfig = readRpcConfig(env);
  const options: PolicyAwareSchemeOptions = {
    policyContracts: normalizePolicyContracts(parseCsv(env.POLICY_CONTRACT_IDS)),
    policyEventTopics: normalizePolicyEventTopics(parseCsv(env.POLICY_EVENT_TOPICS)),
  };
  if (feeProfile !== undefined) {
    options.feeProfile = feeProfile;
  }
  if (rpcConfig !== undefined) {
    options.rpcConfig = rpcConfig;
  }
  const warmCapStroops = readOptionalStroops(env, "WARM_FEE_CAP_STROOPS");
  const coldCapStroops = readOptionalStroops(env, "COLD_FEE_CAP_STROOPS");
  const maxTransactionFeeStroops = readOptionalStroops(env, "MAX_TRANSACTION_FEE_STROOPS");
  if (warmCapStroops !== undefined) {
    options.warmCapStroops = warmCapStroops;
  }
  if (coldCapStroops !== undefined) {
    options.coldCapStroops = coldCapStroops;
  }
  if (maxTransactionFeeStroops !== undefined) {
    options.maxTransactionFeeStroops = maxTransactionFeeStroops;
  }
  const muxed = env.MATCH_MUXED_CONTRACT?.trim().toLowerCase();
  if (muxed === "1" || muxed === "true") {
    options.matchMuxedContract = true;
  }
  return options;
}
