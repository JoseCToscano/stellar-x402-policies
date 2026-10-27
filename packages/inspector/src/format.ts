/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PolicyView {
  address: string;
  name: string;
  wasmHash?: string;
}

export interface SignerView {
  kind: string;
  address: string;
  verifier?: string;
}

export interface RuleView {
  id: number;
  type: string;
  contract?: string;
  name: string;
  validUntil?: number;
  signers: SignerView[];
  policies: PolicyView[];
}

export interface InspectModel {
  address: string;
  baseAddress?: string;
  muxId?: string;
  ledger: number;
  rules: RuleView[];
  merchants: Array<{ merchant: string; remaining: string; allowed: boolean }>;
  historyFill?: { entries: number; capacity: number };
  /** Policy contracts the verifier is configured to accept. */
  allowlist: readonly string[];
}

export interface RenderedInspect {
  warnings: string[];
  json: string;
  text: string;
}

function historyPercent(entries: number, capacity: number): string {
  if (capacity <= 0) {
    return "0.0";
  }
  return ((entries / capacity) * 100).toFixed(1);
}

export function warningsFor(model: InspectModel): string[] {
  const allowed = new Set(model.allowlist);
  const warnings: string[] = [];
  for (const rule of model.rules) {
    if (rule.type === "CallContract" && rule.validUntil === undefined) {
      warnings.push(`agent rule "${rule.name}" has no expiry`);
    }
    for (const policy of rule.policies) {
      if (!allowed.has(policy.address)) {
        const hash = policy.wasmHash === undefined ? "" : ` wasm ${policy.wasmHash}`;
        warnings.push(
          `unknown policy emitter ${policy.address} is not in the verifier allowlist${hash}`,
        );
      }
    }
  }
  if (model.historyFill !== undefined && model.historyFill.capacity > 0) {
    const ratio = model.historyFill.entries / model.historyFill.capacity;
    if (ratio > 0.8) {
      warnings.push(
        `history fill is ${historyPercent(model.historyFill.entries, model.historyFill.capacity)}% (${model.historyFill.entries}/${model.historyFill.capacity})`,
      );
    }
  }
  return warnings;
}

function ruleLine(rule: RuleView): string {
  const until = rule.validUntil === undefined ? "none" : String(rule.validUntil);
  const signers = rule.signers
    .map((signer) =>
      signer.verifier === undefined
        ? `${signer.kind} ${signer.address}`
        : `${signer.kind} verifier ${signer.verifier}`,
    )
    .join(", ");
  const policies = rule.policies
    .map((policy) =>
      policy.name === "unknown" ? `${policy.address}${policy.wasmHash === undefined ? "" : ` ${policy.wasmHash}`}` : policy.name,
    )
    .join(", ");
  const contract = rule.contract === undefined ? "" : ` ${rule.contract}`;
  return `${rule.id}  ${rule.type}${contract}  ${rule.name}  valid_until=${until}  signers=${signers || "none"}  policies=${policies || "none"}`;
}

/** Text table and JSON for `sxp inspect`. */
export function renderInspect(model: InspectModel): RenderedInspect {
  const warnings = warningsFor(model);
  const history =
    model.historyFill === undefined
      ? undefined
      : {
          entries: model.historyFill.entries,
          capacity: model.historyFill.capacity,
          percent: historyPercent(model.historyFill.entries, model.historyFill.capacity),
        };
  const payload = {
    address: model.address,
    ...(model.baseAddress !== undefined ? { baseAddress: model.baseAddress, muxId: model.muxId } : {}),
    ledger: model.ledger,
    warnings,
    rules: model.rules,
    merchants: model.merchants,
    ...(history !== undefined ? { historyFill: history } : {}),
  };
  const lines = [
    `address  ${model.address}`,
    ...(model.baseAddress !== undefined ? [`base     ${model.baseAddress}`, `mux_id   ${model.muxId}`] : []),
    `ledger   ${model.ledger}`,
    "rules",
    ...model.rules.map(ruleLine),
    "merchants",
    ...(model.merchants.length === 0
      ? ["  none"]
      : model.merchants.map(
          (row) => `  ${row.merchant}  remaining=${row.remaining}  allowed=${row.allowed}`,
        )),
    "history",
    history === undefined ? "  unknown" : `  ${history.entries}/${history.capacity} (${history.percent}%)`,
    "warnings",
    ...(warnings.length === 0 ? ["  none"] : warnings.map((warning) => `  - ${warning}`)),
  ];
  return { warnings, json: JSON.stringify(payload, null, 2), text: lines.join("\n") };
}
