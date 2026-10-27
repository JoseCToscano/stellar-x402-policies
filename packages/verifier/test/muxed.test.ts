/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  contractAddressBase,
  encodeContractStrkey,
  encodeMuxedContract,
  sameTransferRecipient,
} from "../src/muxed.js";

describe("muxed contract addresses", () => {
  const contractId = Buffer.alloc(32, 0);

  it("encodes a C address the same way StrKey does", () => {
    expect(encodeContractStrkey(contractId)).toBe(StrKey.encodeContract(contractId));
  });

  it("round-trips a W address to the base contract", () => {
    const base = StrKey.encodeContract(Buffer.alloc(32, 7));
    const muxed = encodeMuxedContract(StrKey.decodeContract(base), 42n);
    expect(muxed.startsWith("W")).toBe(true);
    expect(contractAddressBase(muxed)).toBe(base);
    expect(sameTransferRecipient(muxed, base, false)).toBe(false);
    expect(sameTransferRecipient(muxed, base, true)).toBe(true);
    expect(sameTransferRecipient(base, base, false)).toBe(true);
  });

  it("encodes the all-zero CAP-84 example as a W address", () => {
    const encoded = encodeMuxedContract(contractId, 0n);
    expect(encoded.startsWith("W")).toBe(true);
    expect(contractAddressBase(encoded)).toBe(StrKey.encodeContract(contractId));
  });
});
