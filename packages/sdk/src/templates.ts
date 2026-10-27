/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

import { compareScVal, sortedMap } from "./scval.js";

export interface TemplateDocument {
  name: string;
  description?: string;
  params?: Record<string, string | number>;
  ownerRule: { type: "Default"; name: string; signer: "ed25519" | "passkey" };
  agentRules: TemplateRule[];
}

export interface TemplateRule {
  name: string;
  context: { type: "CallContract"; token: string };
  signer: "agent";
  validUntil: string | number;
  policies: TemplatePolicy[];
}

export type TemplatePolicy =
  | { kind: "spending_limit"; spendingLimit: string | number; periodLedgers: string | number }
  | {
      kind: "merchant_allowlist";
      perTxMax?: string | number;
      merchants: Array<{ address: string; cap: string | number; periodLedgers: string | number }>;
    }
  | {
      kind: "period_cap";
      cap: string | number;
      periodLedgers: string | number;
      anchorLedger: string | number;
      perTxMax?: string | number;
    };

export interface CompiledPolicy {
  kind: string;
  contractId: string;
  paramsXdr: string;
}

export interface CompiledRule {
  name: string;
  token: string;
  validUntil: number;
  policies: CompiledPolicy[];
  /** Base64 ScVal vec of the `add_context_rule` arguments. */
  installXdr: string;
}

export interface CompiledTemplate {
  name: string;
  ownerRule: { type: "Default"; name: string; signer: "ed25519" | "passkey" };
  rules: CompiledRule[];
}

function substitute(value: unknown, params: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([A-Za-z0-9_]+)\}\}$/);
    if (whole?.[1] !== undefined) {
      if (!(whole[1] in params)) {
        throw new Error(`template param ${whole[1]} is missing`);
      }
      return params[whole[1]];
    }
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
      if (!(key in params)) {
        throw new Error(`template param ${key} is missing`);
      }
      return String(params[key]);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, params));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substitute(item, params);
    }
    return out;
  }
  return value;
}

function asNumber(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function asBigint(value: string | number, label: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
  return parsed;
}

function i128(value: bigint): xdr.ScVal {
  const hi = value >> 64n;
  const lo = value & ((1n << 64n) - 1n);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    }),
  );
}

function symbolMap(entries: ReadonlyArray<readonly [string, xdr.ScVal]>): xdr.ScVal {
  return sortedMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

function policyParams(policy: TemplatePolicy): xdr.ScVal {
  if (policy.kind === "spending_limit") {
    return symbolMap([
      ["period_ledgers", xdr.ScVal.scvU32(asNumber(policy.periodLedgers, "periodLedgers"))],
      ["spending_limit", i128(asBigint(policy.spendingLimit, "spendingLimit"))],
    ]);
  }
  if (policy.kind === "period_cap") {
    const fields: Array<readonly [string, xdr.ScVal]> = [
      ["anchor_ledger", xdr.ScVal.scvU32(asNumber(policy.anchorLedger, "anchorLedger"))],
      ["cap", i128(asBigint(policy.cap, "cap"))],
      ["period_ledgers", xdr.ScVal.scvU32(asNumber(policy.periodLedgers, "periodLedgers"))],
    ];
    fields.push([
      "per_tx_max",
      policy.perTxMax !== undefined
        ? i128(asBigint(policy.perTxMax, "perTxMax"))
        : xdr.ScVal.scvVoid(),
    ]);
    return symbolMap(fields);
  }
  const merchants = policy.merchants.map((merchant) => {
    const limit = symbolMap([
      ["cap", i128(asBigint(merchant.cap, "cap"))],
      ["period_ledgers", xdr.ScVal.scvU32(asNumber(merchant.periodLedgers, "periodLedgers"))],
    ]);
    return new xdr.ScMapEntry({ key: new Address(merchant.address).toScVal(), val: limit });
  });
  merchants.sort((left, right) => compareScVal(left.key(), right.key()));
  return symbolMap([
    ["merchants", xdr.ScVal.scvMap(merchants)],
    [
      "per_tx_max",
      policy.perTxMax !== undefined
        ? i128(asBigint(policy.perTxMax, "perTxMax"))
        : xdr.ScVal.scvVoid(),
    ],
  ]);
}

function contractIdFor(kind: TemplatePolicy["kind"], params: Record<string, string | number>): string {
  const key =
    kind === "spending_limit"
      ? "spendingLimitContract"
      : kind === "merchant_allowlist"
        ? "merchantAllowlistContract"
        : "periodCapContract";
  const value = params[key];
  if (typeof value !== "string" || !value.startsWith("C")) {
    throw new Error(`template param ${key} must be a contract id`);
  }
  return value;
}

function installArgs(
  rule: TemplateRule,
  policies: CompiledPolicy[],
  params: Record<string, string | number>,
): string {
  const verifier = params.verifier;
  const agent = params.agent;
  if (typeof verifier !== "string" || typeof agent !== "string") {
    throw new Error("template params verifier and agent are required");
  }
  const publicKey = Buffer.from(Keypair.fromPublicKey(agent).rawPublicKey());
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifier).toScVal(),
    xdr.ScVal.scvBytes(publicKey),
  ]);
  const policyEntries = policies.map(
    (policy) =>
      new xdr.ScMapEntry({
        key: new Address(policy.contractId).toScVal(),
        val: xdr.ScVal.fromXDR(policy.paramsXdr, "base64"),
      }),
  );
  policyEntries.sort((left, right) => compareScVal(left.key(), right.key()));
  const args = xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("CallContract"),
      new Address(rule.context.token).toScVal(),
    ]),
    xdr.ScVal.scvString(rule.name),
    xdr.ScVal.scvU32(asNumber(rule.validUntil, "validUntil")),
    xdr.ScVal.scvVec([signer]),
    xdr.ScVal.scvMap(policyEntries),
  ]);
  return args.toXDR("base64");
}

export function compileTemplate(
  template: TemplateDocument,
  params: Record<string, string | number>,
): CompiledTemplate {
  if (template.ownerRule.type !== "Default") {
    throw new Error("template owner rule must be Default");
  }
  const merged = { ...template.params, ...params };
  const filled = substitute(template, merged) as TemplateDocument;
  const rules = filled.agentRules.map((rule) => {
    if (rule.signer !== "agent") {
      throw new Error(`agent rule ${rule.name} must use the agent signer`);
    }
    const validUntil = asNumber(rule.validUntil, `${rule.name}.validUntil`);
    const policies = rule.policies.map((policy) => ({
      kind: policy.kind,
      contractId: contractIdFor(policy.kind, merged),
      paramsXdr: policyParams(policy).toXDR("base64"),
    }));
    return {
      name: rule.name,
      token: rule.context.token,
      validUntil,
      policies,
      installXdr: installArgs({ ...rule, validUntil }, policies, merged),
    };
  });
  return {
    name: filled.name,
    ownerRule: {
      type: "Default",
      name: filled.ownerRule.name,
      signer: filled.ownerRule.signer,
    },
    rules,
  };
}
