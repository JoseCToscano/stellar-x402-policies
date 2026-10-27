/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateStellarAssetAddress } from "@x402/stellar";

import { BALANCE_MOVING_TOPIC_SET } from "./constants.js";

export function normalizePolicyContracts(contracts: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const contract of contracts) {
    const value = contract.trim();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    if (!validateStellarAssetAddress(value)) {
      throw new Error(`Policy contract id is not a Stellar contract address: ${value}`);
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function normalizePolicyEventTopics(topics: readonly string[] | undefined): string[] {
  if (topics === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const topic of topics) {
    const value = topic.trim();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    if (BALANCE_MOVING_TOPIC_SET.has(value.toLowerCase())) {
      throw new Error(
        `Policy event topic "${value}" is balance-moving and cannot be allowlisted`,
      );
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function parseCsv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
