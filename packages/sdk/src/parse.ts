/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Address, Transaction, xdr } from "@stellar/stellar-sdk";

import type { AccountRule, RuleSigner } from "./types.js";

export interface Invocation {
  contract: string;
  method: string;
  args: xdr.ScVal[];
}

export function readInvocation(tx: Transaction): Invocation | undefined {
  const operation = tx.operations[0];
  if (operation === undefined || operation.type !== "invokeHostFunction") {
    return undefined;
  }
  const func = operation.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    return undefined;
  }
  const invocation = func.invokeContract();
  const name = invocation.functionName();
  return {
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    method: typeof name === "string" ? name : name.toString("utf8"),
    args: invocation.args(),
  };
}

function symbolOf(val: xdr.ScVal): string | undefined {
  if (val.switch().name !== "scvSymbol") {
    return undefined;
  }
  return val.sym().toString();
}

function mapOf(val: xdr.ScVal): Map<string, xdr.ScVal> {
  if (val.switch().name !== "scvMap") {
    throw new Error("expected a contract map");
  }
  const out = new Map<string, xdr.ScVal>();
  for (const entry of val.map() ?? []) {
    const key = symbolOf(entry.key());
    if (key !== undefined) {
      out.set(key, entry.val());
    }
  }
  return out;
}

function addressOf(val: xdr.ScVal): string {
  return Address.fromScVal(val).toString();
}

function readSigner(val: xdr.ScVal): RuleSigner {
  const parts = val.vec() ?? [];
  const kind = parts[0] === undefined ? undefined : symbolOf(parts[0]);
  if (kind === "Delegated" && parts[1] !== undefined) {
    return { kind: "delegated", address: addressOf(parts[1]) };
  }
  if (kind === "External" && parts[1] !== undefined) {
    return { kind: "external", address: "", verifier: addressOf(parts[1]) };
  }
  return { kind: "external", address: "" };
}

export function parseContextRule(val: xdr.ScVal): AccountRule {
  const map = mapOf(val);
  const id = map.get("id");
  const context = map.get("context_type");
  const name = map.get("name");
  if (id === undefined || context === undefined || name === undefined) {
    throw new Error("context rule is missing id, context_type, or name");
  }
  const contextParts = context.vec() ?? [];
  const contextName = contextParts[0] === undefined ? "Unknown" : (symbolOf(contextParts[0]) ?? "Unknown");
  const contract =
    contextName === "CallContract" && contextParts[1] !== undefined
      ? addressOf(contextParts[1])
      : undefined;
  const valid = map.get("valid_until");
  const validUntil =
    valid !== undefined && valid.switch().name === "scvU32" ? valid.u32() : undefined;
  const signers = (map.get("signers")?.vec() ?? []).map((signer) => readSigner(signer));
  const policies = (map.get("policies")?.vec() ?? []).map((policy) => addressOf(policy));
  return {
    id: id.u32(),
    type: contextName,
    ...(contract !== undefined ? { contract } : {}),
    name: name.str().toString(),
    ...(validUntil !== undefined ? { validUntil } : {}),
    signers,
    policies,
  };
}

export function readU32(val: xdr.ScVal): number {
  if (val.switch().name !== "scvU32") {
    throw new Error("expected u32");
  }
  return val.u32();
}

export function readI128(val: xdr.ScVal): bigint {
  if (val.switch().name !== "scvI128") {
    throw new Error("expected i128");
  }
  const parts = val.i128();
  return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
}
