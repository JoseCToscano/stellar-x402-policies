/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Address,
  Keypair,
  Networks,
  Transaction,
  xdr,
  type Transaction as Tx,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { authDigest } from "../src/auth.js";
import { SpendingPolicyKit } from "../src/kit.js";
import { readInvocation } from "../src/parse.js";
import type { KitRpc, SimulatedCall } from "../src/rpc.js";
import { Ed25519Signer, webAuthnTestDouble } from "../src/signers.js";
import type { TemplateDocument } from "../src/templates.js";
import { PayRefused, type ExactRequirements } from "../src/types.js";

const PASSPHRASE = Networks.TESTNET;
const SOURCE = Keypair.random().publicKey();
const ACCOUNT = Address.fromString(
  "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6",
).toString();
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const MERCHANT = Keypair.random().publicKey();
const VERIFIER = "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4";

function ruleVal(validUntil: number | undefined): xdr.ScVal {
  const fields: xdr.ScMapEntry[] = [
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_type"),
      val: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        new Address(ASSET).toScVal(),
      ]),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("id"), val: xdr.ScVal.scvU32(1) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("name"),
      val: xdr.ScVal.scvString("agent"),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("policies"),
      val: xdr.ScVal.scvVec([new Address(VERIFIER).toScVal()]),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: xdr.ScVal.scvVec([]) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("valid_until"),
      val: validUntil === undefined ? xdr.ScVal.scvVoid() : xdr.ScVal.scvU32(validUntil),
    }),
  ];
  fields.sort((left, right) => Buffer.compare(left.key().toXDR(), right.key().toXDR()));
  return xdr.ScVal.scvMap(fields);
}

function authEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ASSET).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

class MockRpc implements KitRpc {
  readonly calls: string[] = [];
  transfer: SimulatedCall = { minResourceFee: 58_228, rentStroops: 0, auth: [authEntry()] };
  ledger = 1_000;
  validUntil: number | undefined = 5_000;

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: this.ledger };
  }

  async getAccount(): Promise<{ sequence: string }> {
    return { sequence: "10" };
  }

  async simulate(tx: Tx): Promise<SimulatedCall> {
    const call = readInvocation(tx);
    this.calls.push(call?.method ?? "unknown");
    if (call?.method === "get_context_rules_count") {
      return { minResourceFee: 100, retval: xdr.ScVal.scvU32(1) };
    }
    if (call?.method === "get_context_rule") {
      return { minResourceFee: 100, retval: ruleVal(this.validUntil) };
    }
    if (call?.method === "transfer") {
      return this.transfer;
    }
    return { minResourceFee: 0, error: `unexpected ${call?.method}` };
  }

  async getTransaction(): Promise<{ feeCharged: number }> {
    return { feeCharged: 48_067 };
  }
}

function requirements(amount = "1000000"): ExactRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount,
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
  };
}

function kit(rpc: MockRpc, fetchImpl?: typeof fetch): SpendingPolicyKit {
  return new SpendingPolicyKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    facilitatorUrl: "http://127.0.0.1:4020",
    sourceAccount: SOURCE,
    verifier: VERIFIER,
    agentAccount: Keypair.random().publicKey(),
    rpc,
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
}

describe("precheck", () => {
  it("returns every precheck reason from the mocked RPC", async () => {
    const cases: Array<{ reason: string; prepare: (rpc: MockRpc) => void }> = [
      {
        reason: "expired",
        prepare: (rpc) => {
          rpc.ledger = 20;
          rpc.validUntil = 10;
        },
      },
      {
        reason: "merchant_not_allowed",
        prepare: (rpc) => {
          rpc.transfer = { minResourceFee: 0, error: "HostError: Error(Contract, #3401)" };
        },
      },
      {
        reason: "over_cap",
        prepare: (rpc) => {
          rpc.transfer = { minResourceFee: 0, error: "HostError: Error(Contract, #3402)" };
        },
      },
      {
        reason: "over_per_tx",
        prepare: (rpc) => {
          rpc.transfer = { minResourceFee: 0, error: "HostError: Error(Contract, #3403)" };
        },
      },
      {
        reason: "history_full",
        prepare: (rpc) => {
          rpc.transfer = { minResourceFee: 0, error: "HostError: Error(Contract, #3407)" };
        },
      },
    ];
    for (const entry of cases) {
      const rpc = new MockRpc();
      entry.prepare(rpc);
      const result = await kit(rpc).precheck(requirements(), ACCOUNT);
      expect(result, entry.reason).toEqual({
        ok: false,
        reason: entry.reason,
        needsOwnerApproval: true,
      });
    }
  });

  it("does not simulate a transfer after the rule has expired", async () => {
    const rpc = new MockRpc();
    rpc.ledger = 20;
    rpc.validUntil = 10;
    await kit(rpc).precheck(requirements(), ACCOUNT);
    expect(rpc.calls).not.toContain("transfer");
  });
});

describe("pay", () => {
  it("refuses locally when precheck fails and does not call the facilitator", async () => {
    const rpc = new MockRpc();
    rpc.transfer = { minResourceFee: 0, error: "HostError: Error(Contract, #3402)" };
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      throw new Error("facilitator should not be called");
    };
    const signer = new Ed25519Signer(Keypair.random());
    await expect(kit(rpc, fetchImpl).pay(requirements(), { signer, account: ACCOUNT })).rejects.toBeInstanceOf(
      PayRefused,
    );
    expect(calls).toEqual([]);
  });

  it("signs the auth entry and settles when precheck passes", async () => {
    const rpc = new MockRpc();
    const agent = Keypair.random();
    let settled = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      settled = String(init?.body);
      return new Response(JSON.stringify({ success: true, transaction: "a".repeat(64) }), {
        status: 200,
      });
    };
    const paymentKit = new SpendingPolicyKit({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: PASSPHRASE,
      facilitatorUrl: "http://127.0.0.1:4020",
      sourceAccount: SOURCE,
      verifier: VERIFIER,
      agentAccount: agent.publicKey(),
      rpc,
      fetch: fetchImpl,
    });
    const receipt = await paymentKit.pay(requirements("500000"), {
      signer: new Ed25519Signer(agent),
      maxAmount: 1_000_000n,
      account: ACCOUNT,
    });
    expect(receipt.txHash).toBe("a".repeat(64));
    expect(receipt.feeCharged).toBe(48_067);
    expect(settled).toContain("paymentPayload");
    const parsed = JSON.parse(settled) as { paymentPayload: { payload: { transaction: string } } };
    const tx = new Transaction(parsed.paymentPayload.payload.transaction, PASSPHRASE);
    const operation = tx.operations[0];
    expect(operation?.type).toBe("invokeHostFunction");
    if (operation?.type === "invokeHostFunction") {
      expect(operation.auth?.[0]?.credentials().switch().name).toBe("sorobanCredentialsAddress");
      const signature = operation.auth?.[0]?.credentials().address().signature();
      expect(signature?.switch().name).not.toBe("scvVoid");
    }
  });
});

describe("estimateFee", () => {
  it("classifies a mocked warm simulation", async () => {
    const rpc = new MockRpc();
    const estimate = await kit(rpc).estimateFee(requirements(), ACCOUNT);
    expect(estimate.class).toBe("warm");
    expect(estimate.simulatedStroops).toBe(58_328);
  });

  it("classifies a mocked cold simulation that carries rent", async () => {
    const rpc = new MockRpc();
    rpc.transfer = { minResourceFee: 369_688, rentStroops: 311_460 };
    const estimate = await kit(rpc).estimateFee(requirements(), ACCOUNT);
    expect(estimate.class).toBe("cold");
    expect(estimate.simulatedStroops).toBe(369_788);
    expect(estimate.recommendedCeiling).toBe(6_500_000);
  });
});

describe("signers and digest", () => {
  it("invokes the WebAuthn test double with the digest", async () => {
    const { signer, digests } = webAuthnTestDouble(new Uint8Array(64).fill(7));
    const digest = authDigest(ACCOUNT, Buffer.alloc(32, 3), [1]);
    const signature = await signer.sign(digest);
    expect(digests).toHaveLength(1);
    expect(Buffer.from(signature).equals(Buffer.alloc(64, 7))).toBe(true);
  });
});

describe("templates.compile", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const agent = Keypair.random().publicKey();
  const params = {
    usdc: ASSET,
    xlm: ASSET,
    dailyCap: "10000000",
    perTxMax: "1500000",
    periodLedgers: 17280,
    anchorLedger: 1000,
    validUntil: 9_000_000,
    assetCap: "10000000",
    merchantCap: "3000000",
    merchantA: ACCOUNT,
    monthlyCap: "100000000",
    spendingLimitContract: VERIFIER,
    merchantAllowlistContract: ACCOUNT,
    periodCapContract: ACCOUNT,
    verifier: VERIFIER,
    agent,
  };

  it("keeps a Default owner rule and a numeric validUntil for every template", () => {
    for (const name of [
      "agent-daily-usdc",
      "agent-merchant-allowlist",
      "agent-monthly-multi-asset",
    ]) {
      const template = JSON.parse(
        readFileSync(join(root, "templates", `${name}.json`), "utf8"),
      ) as TemplateDocument;
      const compiled = kit(new MockRpc()).templates.compile(template, params);
      expect(compiled.ownerRule.type).toBe("Default");
      expect(["ed25519", "passkey"]).toContain(compiled.ownerRule.signer);
      expect(compiled.rules.length).toBeGreaterThan(0);
      for (const rule of compiled.rules) {
        expect(rule.validUntil).toBe(9_000_000);
        expect(rule.installXdr.length).toBeGreaterThan(10);
        const decoded = xdr.ScVal.fromXDR(rule.installXdr, "base64");
        expect(decoded.switch().name).toBe("scvVec");
      }
    }
  });
});
