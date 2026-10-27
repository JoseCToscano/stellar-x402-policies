/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Address, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { SpendingPolicyKitOptions } from "@stellar-x402-policies/sdk";

type KitRpc = NonNullable<SpendingPolicyKitOptions["rpc"]>;
type SimulatedCall = Awaited<ReturnType<KitRpc["simulate"]>>;

export const MOCK_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function symbol(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function ruleVal(asset: string): xdr.ScVal {
  const fields: xdr.ScMapEntry[] = [
    new xdr.ScMapEntry({
      key: symbol("context_type"),
      val: xdr.ScVal.scvVec([symbol("CallContract"), new Address(asset).toScVal()]),
    }),
    new xdr.ScMapEntry({ key: symbol("id"), val: xdr.ScVal.scvU32(1) }),
    new xdr.ScMapEntry({ key: symbol("name"), val: xdr.ScVal.scvString("agent") }),
    new xdr.ScMapEntry({ key: symbol("policies"), val: xdr.ScVal.scvVec([]) }),
    new xdr.ScMapEntry({ key: symbol("signers"), val: xdr.ScVal.scvVec([]) }),
    new xdr.ScMapEntry({ key: symbol("valid_until"), val: xdr.ScVal.scvU32(9_000_000) }),
  ];
  fields.sort((left, right) => Buffer.compare(left.key().toXDR(), right.key().toXDR()));
  return xdr.ScVal.scvMap(fields);
}

function authEntry(account: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(account).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(MOCK_ASSET).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function methodOf(tx: Transaction): string {
  const operation = tx.operations[0];
  if (operation === undefined || operation.type !== "invokeHostFunction") {
    return "unknown";
  }
  const func = operation.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    return "unknown";
  }
  const name = func.invokeContract().functionName();
  return typeof name === "string" ? name : name.toString("utf8");
}

/** In-process RPC used when SXP_MOCK is set. It does not open a network connection. */
export function mockRpc(mode: "ok" | "over_cap", account: string): KitRpc {
  const transfer: SimulatedCall =
    mode === "over_cap"
      ? { minResourceFee: 0, error: "HostError: Error(Contract, #3402)" }
      : { minResourceFee: 58_228, rentStroops: 0, auth: [authEntry(account)] };
  return {
    async getLatestLedger() {
      return { sequence: 1_000 };
    },
    async getAccount() {
      return { sequence: "10" };
    },
    async simulate(tx: Transaction): Promise<SimulatedCall> {
      const method = methodOf(tx);
      if (method === "get_context_rules_count") {
        return { minResourceFee: 100, retval: xdr.ScVal.scvU32(1) };
      }
      if (method === "get_context_rule") {
        return { minResourceFee: 100, retval: ruleVal(MOCK_ASSET) };
      }
      if (method === "transfer") {
        return transfer;
      }
      return { minResourceFee: 0, error: `unexpected ${method}` };
    },
    async getTransaction() {
      return { feeCharged: 48_067 };
    },
  };
}
