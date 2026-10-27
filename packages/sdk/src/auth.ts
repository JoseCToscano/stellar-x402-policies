/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * stellar-accounts 0.8.0 signs AuthDigestPreimage, the SHA-256 of that
 * struct's ScVal XDR. Map keys sort as account, context_rule_ids,
 * signature_payload. The Ed25519 verifier checks the 32-byte digest.
 */

import {
  Address,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
} from "@stellar/stellar-sdk";

import type { AgentSigner } from "./signers.js";

function sortedMap(entries: readonly xdr.ScMapEntry[]): xdr.ScVal {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(left.key().toXDR(), right.key().toXDR()),
  );
  return xdr.ScVal.scvMap(sorted);
}

function symbolEntry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

/** ScVal XDR preimage that stellar-accounts 0.8.0 hashes for external signers. */
export function authDigestPreimage(
  account: string,
  signaturePayload: Buffer,
  contextRuleIds: readonly number[],
): xdr.ScVal {
  return sortedMap([
    symbolEntry("account", new Address(account).toScVal()),
    symbolEntry(
      "context_rule_ids",
      xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    ),
    symbolEntry("signature_payload", xdr.ScVal.scvBytes(signaturePayload)),
  ]);
}

export function authDigest(
  account: string,
  signaturePayload: Buffer,
  contextRuleIds: readonly number[],
): Buffer {
  return hash(authDigestPreimage(account, signaturePayload, contextRuleIds).toXDR());
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  const name = credentials.switch().name;
  if (name === "sorobanCredentialsAddress") {
    return credentials.address();
  }
  if (name === "sorobanCredentialsAddressV2") {
    return credentials.addressV2();
  }
  throw new Error(`unsupported Soroban credential ${name}`);
}

export function externalSigner(verifier: string, publicKey: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifier).toScVal(),
    xdr.ScVal.scvBytes(publicKey),
  ]);
}

/**
 * Replaces the void signature on a simulated auth entry. Signs the v0.8.0
 * digest with `signer`. Does not sign the transaction envelope.
 */
export async function signAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  options: {
    networkPassphrase: string;
    expirationLedger: number;
    contextRuleId: number;
    verifier: string;
    publicKey: Buffer;
    signer: AgentSigner;
    smartAccount: string;
  },
): Promise<xdr.SorobanAuthorizationEntry> {
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = addressCredentials(signed);
  const address = Address.fromScAddress(credentials.address()).toString();
  if (address !== options.smartAccount) {
    throw new Error(`auth entry address ${address} is not the smart account`);
  }
  if (signed.rootInvocation().subInvocations().length > 0) {
    throw new Error("smart-account auth entry has sub-invocations");
  }
  credentials.signatureExpirationLedger(options.expirationLedger);
  const preimage = buildAuthorizationEntryPreimage(
    signed,
    options.expirationLedger,
    options.networkPassphrase,
  );
  const signaturePayload = hash(preimage.toXDR());
  const digest = authDigest(options.smartAccount, signaturePayload, [options.contextRuleId]);
  const signature = Buffer.from(await options.signer.sign(digest));
  const signerKey = externalSigner(options.verifier, options.publicKey);
  credentials.signature(
    sortedMap([
      symbolEntry(
        "context_rule_ids",
        xdr.ScVal.scvVec([xdr.ScVal.scvU32(options.contextRuleId)]),
      ),
      symbolEntry(
        "signers",
        sortedMap([new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(signature) })]),
      ),
    ]),
  );
  return signed;
}
