/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { rpc, Transaction, xdr } from "@stellar/stellar-sdk";

export interface SimulatedCall {
  minResourceFee: number;
  error?: string;
  auth?: xdr.SorobanAuthorizationEntry[];
  retval?: xdr.ScVal;
  /** First-touch rent already included in minResourceFee, when known. */
  rentStroops?: number;
}

/** Narrow RPC surface. Tests pass a fake. Production uses `stellarRpc`. */
export interface KitRpc {
  getLatestLedger(): Promise<{ sequence: number }>;
  getAccount(accountId: string): Promise<{ sequence: string }>;
  simulate(tx: Transaction): Promise<SimulatedCall>;
  getTransaction?(hash: string): Promise<{ feeCharged: number }>;
}

export function stellarRpc(url: string): KitRpc {
  const server = new rpc.Server(url);
  return {
    async getLatestLedger() {
      const latest = await server.getLatestLedger();
      return { sequence: latest.sequence };
    },
    async getAccount(accountId: string) {
      const account = await server.getAccount(accountId);
      return { sequence: account.sequenceNumber() };
    },
    async simulate(tx: Transaction) {
      const simulated = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulated)) {
        return { minResourceFee: 0, error: simulated.error };
      }
      if (!rpc.Api.isSimulationSuccess(simulated)) {
        return { minResourceFee: 0, error: "simulation did not succeed" };
      }
      return {
        minResourceFee: Number(simulated.minResourceFee),
        auth: simulated.result?.auth,
        retval: simulated.result?.retval,
      };
    },
    async getTransaction(hash: string) {
      const result = await server.getTransaction(hash);
      if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`transaction ${hash} is ${result.status}`);
      }
      return { feeCharged: Number(result.resultXdr.feeCharged()) };
    },
  };
}
