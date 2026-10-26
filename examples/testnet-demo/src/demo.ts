/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testnet helper for a policy-aware facilitator. Keys come from the
 * environment (or a gitignored .env). This script prints the public config,
 * and verifies — or settles, when SETTLE=true — a payload the caller supplies
 * as PAYMENT_TRANSACTION_XDR.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { validateStellarAssetAddress, validateStellarDestinationAddress, createEd25519Signer } from "@x402/stellar";
import { PolicyAwareExactStellarScheme, readPolicyAwareOptions } from "stellar-x402-policies";

import { loadLocalEnv, readNetwork, requireEnv } from "./dotenv.js";

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const network = readNetwork();
  const options = readPolicyAwareOptions(process.env);
  const xdr = process.env.PAYMENT_TRANSACTION_XDR?.trim() ?? "";

  console.log(
    JSON.stringify({
      network,
      feeProfile: options.feeProfile ?? "warm",
      warmCapStroops: options.warmCapStroops ?? null,
      coldCapStroops: options.coldCapStroops ?? null,
      maxTransactionFeeStroops: options.maxTransactionFeeStroops ?? null,
      policyContracts: options.policyContracts ?? [],
      policyEventTopics: options.policyEventTopics ?? [],
      customRpc: options.rpcConfig !== undefined,
      hasPaymentPayload: xdr.length > 0,
    }),
  );

  if (xdr.length === 0) {
    console.log(
      "No PAYMENT_TRANSACTION_XDR set. Copy .env.example to .env, add a signed payload, and run again to verify it.",
    );
    return;
  }

  const asset = requireEnv("ASSET_CONTRACT_ID");
  const payTo = requireEnv("PAY_TO");
  const amount = requireEnv("AMOUNT");
  if (!validateStellarAssetAddress(asset)) {
    throw new Error("ASSET_CONTRACT_ID must be a Stellar contract address");
  }
  if (!validateStellarDestinationAddress(payTo)) {
    throw new Error("PAY_TO must be a Stellar account or contract address");
  }
  if (!/^\d+$/.test(amount)) {
    throw new Error("AMOUNT must be an integer number of token base units");
  }

  const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET_KEY"), network);
  const scheme = new PolicyAwareExactStellarScheme([signer], options);
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: readPositiveInt("MAX_TIMEOUT_SECONDS", 60),
    extra: {},
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: xdr },
  };

  console.log(
    JSON.stringify({
      facilitator: signer.address,
      feeProfile: scheme.feeProfile.name,
      maxTransactionFeeStroops: scheme.maxTransactionFeeStroops,
    }),
  );

  const verified = await scheme.verify(payload, requirements);
  console.log(JSON.stringify({ verify: verified }));
  if (!verified.isValid) {
    process.exitCode = 1;
    return;
  }

  if (process.env.SETTLE?.trim().toLowerCase() !== "true") {
    console.log("Verified. Set SETTLE=true to submit the transaction.");
    return;
  }

  const settled = await scheme.settle(payload, requirements);
  console.log(JSON.stringify({ settle: settled }));
  if (!settled.success) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Demo failed";
  console.error(message);
  process.exitCode = 1;
});
