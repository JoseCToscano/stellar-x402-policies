/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Encoding for the OpenZeppelin stellar-contracts smart account published for
 * protocol 27 (commit 1e513890). The on-chain digest is
 * sha256(raw host signature payload || context_rule_ids ScVal XDR).
 * Ed25519 signatures in the AuthPayload are the raw 64-byte signature.
 */

import {
  Address,
  buildAuthorizationEntryPreimage,
  hash,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";

/** Testnet deployment from smart-account-kit docs/deployments-protocol-27-2026-07-09.md. */
export const ACCOUNT_WASM_HASH =
  "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";
export const ED25519_VERIFIER =
  "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4";
export const SPENDING_LIMIT_POLICY =
  "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G";

/** Constructor installs this rule. It matches every call and has no policy. */
export const DEFAULT_RULE_ID = 0;
/** `add_context_rule` installs the spending-limit rule at the next id. */
export const SPENDING_RULE_ID = 1;

export function externalSigner(verifier: string, publicKey: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifier).toScAddress()),
    xdr.ScVal.scvBytes(publicKey),
  ]);
}

export function signerList(verifier: string, publicKey: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([externalSigner(verifier, publicKey)]);
}

export function emptyPolicyMap(): xdr.ScVal {
  return xdr.ScVal.scvMap([]);
}

export function callContractRule(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CallContract"),
    xdr.ScVal.scvAddress(Address.fromString(contractId).toScAddress()),
  ]);
}

export function spendingLimitParams(limit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("period_ledgers"),
      val: xdr.ScVal.scvU32(periodLedgers),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("spending_limit"),
      val: xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString("0"),
          lo: xdr.Uint64.fromString(limit.toString()),
        }),
      ),
    }),
  ]);
}

export function policyInstallMap(policy: string, params: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: Address.fromString(policy).toScVal(),
      val: params,
    }),
  ]);
}

export function buildAuthDigest(signaturePayload: Buffer, contextRuleIds: readonly number[]): Buffer {
  const ruleIds = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
  return hash(Buffer.concat([signaturePayload, ruleIds]));
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    default:
      throw new Error(`unsupported Soroban credential ${credentials.switch().name}`);
  }
}

export function authEntryAddress(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  try {
    return Address.fromScAddress(addressCredentials(entry).address()).toString();
  } catch {
    return undefined;
  }
}

export function invocationCount(invocation: xdr.SorobanAuthorizedInvocation): number {
  let total = 1;
  for (const child of invocation.subInvocations()) {
    total += invocationCount(child);
  }
  return total;
}

/**
 * Fills a simulation auth entry with an Ed25519 AuthPayload. The host
 * signature payload is the protocol preimage for the entry's credential
 * version. The account then binds the selected context-rule ids.
 */
export function signSmartAccountEntry(
  entry: xdr.SorobanAuthorizationEntry,
  options: {
    networkPassphrase: string;
    expirationLedger: number;
    contextRuleId: number;
    verifier: string;
    signer: Keypair;
    smartAccount: string;
  },
): xdr.SorobanAuthorizationEntry {
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = addressCredentials(signed);
  const address = Address.fromScAddress(credentials.address()).toString();
  if (address !== options.smartAccount) {
    throw new Error(`auth entry address ${address} is not the smart account`);
  }
  const contexts = invocationCount(signed.rootInvocation());
  if (signed.rootInvocation().subInvocations().length > 0) {
    throw new Error(
      `smart-account auth entry has ${signed.rootInvocation().subInvocations().length} sub-invocations; ExactStellarScheme rejects those`,
    );
  }
  const contextRuleIds = Array.from({ length: contexts }, () => options.contextRuleId);
  credentials.signatureExpirationLedger(options.expirationLedger);
  const preimage = buildAuthorizationEntryPreimage(
    signed,
    options.expirationLedger,
    options.networkPassphrase,
  );
  const signaturePayload = hash(preimage.toXDR());
  const digest = buildAuthDigest(signaturePayload, contextRuleIds);
  const signature = Buffer.from(options.signer.sign(digest));
  const signerKey = externalSigner(options.verifier, Buffer.from(options.signer.rawPublicKey()));
  credentials.signature(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKey,
            val: xdr.ScVal.scvBytes(signature),
          }),
        ]),
      }),
    ]),
  );
  return signed;
}
