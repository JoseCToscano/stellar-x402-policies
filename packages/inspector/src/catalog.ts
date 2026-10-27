/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DeploymentFile {
  contracts: {
    merchantAllowlist: { contractId: string };
    periodCap: { contractId: string };
  };
  reused?: {
    spendingLimit?: { contractId: string };
    simpleThreshold?: string;
    weightedThreshold?: string;
    ed25519Verifier?: string;
    accountWasmHash?: string;
  };
}

export function repoRoot(start: string): string {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, "templates", "schema.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("templates/schema.json was not found");
}

export function loadDeployments(root: string): DeploymentFile {
  return JSON.parse(readFileSync(join(root, "deployments", "testnet.json"), "utf8")) as DeploymentFile;
}

/** Contract ids whose events the verifier may accept. */
export function eventAllowlist(doc: DeploymentFile): string[] {
  const ids = [
    doc.contracts.merchantAllowlist.contractId,
    doc.contracts.periodCap.contractId,
  ];
  const spending = doc.reused?.spendingLimit?.contractId;
  if (spending !== undefined) {
    ids.push(spending);
  }
  return ids;
}

export function policyNames(doc: DeploymentFile): Map<string, string> {
  const names = new Map<string, string>([
    [doc.contracts.merchantAllowlist.contractId, "merchant-allowlist"],
    [doc.contracts.periodCap.contractId, "period-cap"],
  ]);
  const spending = doc.reused?.spendingLimit?.contractId;
  const threshold = doc.reused?.simpleThreshold;
  const weighted = doc.reused?.weightedThreshold;
  if (spending !== undefined) {
    names.set(spending, "spending_limit");
  }
  if (threshold !== undefined) {
    names.set(threshold, "simple_threshold");
  }
  if (weighted !== undefined) {
    names.set(weighted, "weighted_threshold");
  }
  return names;
}
