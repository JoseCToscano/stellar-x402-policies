/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Protocol 30 (CAP-84) muxed contract addresses use strkey version
 * `22 << 3` (`0xb0`) and the prefix `W`. `@stellar/stellar-sdk` 16.4 does not
 * export that type. This module decodes the strkey described in CAP-84 so a
 * W destination can be compared with the base contract id the SAC puts in the
 * `transfer` event. Callers keep it behind `matchMuxedContract`.
 */

import { StrKey } from "@stellar/stellar-sdk";

/** SEP-23 contract version byte (`2 << 3`). */
const CONTRACT_VERSION = 2 << 3;
/** CAP-84 / SEP-23 muxed-contract version byte (`22 << 3`). */
export const MUXED_CONTRACT_VERSION = 22 << 3;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface MuxedContract {
  contractId: Uint8Array;
  id: bigint;
}

function crc16xmodem(payload: Uint8Array): Uint8Array {
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return Uint8Array.of(crc & 0xff, (crc >>> 8) & 0xff);
}

function encodeBase32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    encoded += BASE32[(value << (5 - bits)) & 31];
  }
  return encoded;
}

function decodeBase32(text: string): Uint8Array | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      return undefined;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function encodeStrkey(version: number, data: Uint8Array): string {
  const payload = new Uint8Array(1 + data.length);
  payload[0] = version;
  payload.set(data, 1);
  const checksum = crc16xmodem(payload);
  const unencoded = new Uint8Array(payload.length + checksum.length);
  unencoded.set(payload);
  unencoded.set(checksum, payload.length);
  return encodeBase32(unencoded);
}

function decodeStrkey(version: number, encoded: string): Uint8Array | undefined {
  const decoded = decodeBase32(encoded);
  if (decoded === undefined || decoded.length < 3 || decoded[0] !== version) {
    return undefined;
  }
  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = decoded.subarray(decoded.length - 2);
  const expected = crc16xmodem(payload);
  if (checksum[0] !== expected[0] || checksum[1] !== expected[1]) {
    return undefined;
  }
  if (encodeBase32(decoded) !== encoded) {
    return undefined;
  }
  return payload.subarray(1);
}

/** Encode a contract id and mux id as a W address. Used by tests and tooling. */
export function encodeMuxedContract(contractId: Uint8Array, id: bigint): string {
  if (contractId.length !== 32) {
    throw new Error("contract id must be 32 bytes");
  }
  if (id < 0n || id > 0xffff_ffff_ffff_ffffn) {
    throw new Error("mux id must be a uint64");
  }
  const payload = new Uint8Array(40);
  payload.set(contractId, 0);
  const view = new DataView(payload.buffer);
  view.setBigUint64(32, id, false);
  return encodeStrkey(MUXED_CONTRACT_VERSION, payload);
}

export function decodeMuxedContract(address: string): MuxedContract | undefined {
  const data = decodeStrkey(MUXED_CONTRACT_VERSION, address);
  if (data === undefined || data.length !== 40) {
    return undefined;
  }
  const contractId = data.subarray(0, 32);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { contractId, id: view.getBigUint64(32, false) };
}

/**
 * Contract id (C...) for a C address or for a W address. Account addresses
 * and malformed strings return undefined.
 */
export function contractAddressBase(address: string): string | undefined {
  if (address.startsWith("C") && StrKey.isValidContract(address)) {
    return address;
  }
  if (!address.startsWith("W")) {
    return undefined;
  }
  const muxed = decodeMuxedContract(address);
  if (muxed === undefined) {
    return undefined;
  }
  return StrKey.encodeContract(Buffer.from(muxed.contractId));
}

/**
 * Compare a payment recipient with a transfer event `to`.
 *
 * String equality is always enough. When `allowMuxedContract` is set, a W
 * address matches the C address of its base contract (CAP-84: the SAC event
 * carries the base contract in `to`).
 */
export function sameTransferRecipient(
  expected: string,
  actual: string,
  allowMuxedContract = false,
): boolean {
  if (expected === actual) {
    return true;
  }
  if (!allowMuxedContract) {
    return false;
  }
  const expectedBase = contractAddressBase(expected);
  const actualBase = contractAddressBase(actual);
  return expectedBase !== undefined && expectedBase === actualBase;
}

/** Round-trip check used by tests: our contract encoder matches StrKey. */
export function encodeContractStrkey(contractId: Uint8Array): string {
  return encodeStrkey(CONTRACT_VERSION, contractId);
}
