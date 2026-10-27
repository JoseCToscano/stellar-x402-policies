/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { FacilitatorStellarSigner } from "@x402/stellar";

export const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const FROM = Keypair.random().publicKey();
export const TO = Keypair.random().publicKey();
export const POLICY = StrKey.encodeContract(Buffer.alloc(32, 7));
export const OTHER = StrKey.encodeContract(Buffer.alloc(32, 9));

export const signer: FacilitatorStellarSigner = {
  address: FROM,
  signAuthEntry: async () => {
    throw new Error("signAuthEntry is not used in unit tests");
  },
  signTransaction: async () => {
    throw new Error("signTransaction is not used in unit tests");
  },
};

export function symbol(name: string): xdr.ScVal {
  return nativeToScVal(name, { type: "symbol" });
}

export function address(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "address" });
}

export function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

export function contractEvent(
  contractId: string | null,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  type: "contract" | "diagnostic" = "contract",
): xdr.DiagnosticEvent {
  const body = new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data }));
  const event = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId:
      contractId === null
        ? null
        : (StrKey.decodeContract(contractId) as unknown as xdr.ContractId),
    type: type === "contract" ? xdr.ContractEventType.contract() : xdr.ContractEventType.diagnostic(),
    body,
  });
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall: true, event });
}

export function transferEvent(
  amount: bigint = 1000n,
  from: string = FROM,
  to: string = TO,
  asset: string = ASSET,
): xdr.DiagnosticEvent {
  return contractEvent(asset, [symbol("transfer"), address(from), address(to)], i128(amount));
}

export function policyEvent(
  topic: string = "spending_limit_enforced",
  contractId: string = POLICY,
): xdr.DiagnosticEvent {
  return contractEvent(contractId, [symbol(topic), address(FROM)], i128(1n));
}
