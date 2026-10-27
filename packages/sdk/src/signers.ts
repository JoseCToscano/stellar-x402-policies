/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Keypair } from "@stellar/stellar-sdk";

/** Signs the 32-byte auth digest. Browser WebAuthn stays behind the callback. */
export interface AgentSigner {
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

export class Ed25519Signer implements AgentSigner {
  readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  sign(digest: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(this.keypair.sign(Buffer.from(digest)));
  }
}

/**
 * WebAuthn signer. `callback` receives the digest and returns the signature
 * bytes. No browser APIs are imported; tests pass a double.
 */
export class WebAuthnSigner implements AgentSigner {
  constructor(private readonly callback: (digest: Uint8Array) => Promise<Uint8Array>) {}

  sign(digest: Uint8Array): Promise<Uint8Array> {
    return this.callback(digest);
  }
}

/** Test double that returns a fixed signature and records the digest. */
export function webAuthnTestDouble(signature: Uint8Array): {
  signer: WebAuthnSigner;
  digests: Uint8Array[];
} {
  const digests: Uint8Array[] = [];
  const signer = new WebAuthnSigner(async (digest) => {
    digests.push(digest);
    return signature;
  });
  return { signer, digests };
}
