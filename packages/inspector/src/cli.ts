#!/usr/bin/env node
/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SpendingPolicyKit, compileTemplate, type TemplateDocument } from "@stellar-x402-policies/sdk";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { contractAddressBase, decodeMuxedContract } from "stellar-x402-policies";

import { eventAllowlist, loadDeployments, policyNames, repoRoot } from "./catalog.js";
import { renderInspect, type InspectModel, type PolicyView, type RuleView } from "./format.js";

interface Flags {
  positionals: string[];
  boolean: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): Flags {
  const positionals: string[] = [];
  const boolean = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--json" || token === "--dry-run") {
      boolean.add(token.slice(2));
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} needs a value`);
      }
      values.set(key, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, boolean, values };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function networkPassphrase(env: NodeJS.ProcessEnv): string {
  const network = (env.SXP_NETWORK ?? "testnet").trim().toLowerCase();
  if (network === "mainnet" && env.SXP_ALLOW_MAINNET !== "1") {
    fail("refusing to start: SXP_NETWORK=mainnet requires SXP_ALLOW_MAINNET=1");
  }
  if (network === "mainnet") {
    return Networks.PUBLIC;
  }
  if (network !== "testnet") {
    fail("SXP_NETWORK must be testnet or mainnet");
  }
  return Networks.TESTNET;
}

function root(): string {
  return repoRoot(dirname(fileURLToPath(import.meta.url)));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function templatePath(name: string): string {
  if (name.endsWith(".json")) {
    return name;
  }
  return join(root(), "templates", `${name}.json`);
}

function printTemplate(name: string, paramsPath: string): void {
  const template = readJson(templatePath(name)) as TemplateDocument;
  const params = readJson(paramsPath) as Record<string, string | number>;
  const compiled = compileTemplate(template, params);
  const lines = [
    `template: ${compiled.name}`,
    `ownerRule: ${compiled.ownerRule.type} ${compiled.ownerRule.name} ${compiled.ownerRule.signer}`,
  ];
  for (const rule of compiled.rules) {
    lines.push(`rule: ${rule.name} token=${rule.token} validUntil=${rule.validUntil}`);
    for (const policy of rule.policies) {
      lines.push(`policy: ${policy.kind} contract=${policy.contractId}`);
      lines.push(`paramsXdr: ${policy.paramsXdr}`);
    }
    lines.push(`installXdr: ${rule.installXdr}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function exportAllowlist(): void {
  const ids = eventAllowlist(loadDeployments(root()));
  process.stdout.write(`X402_POLICY_EVENT_CONTRACTS=${ids.join(",")}\n`);
}

function listTemplates(): void {
  const names = readdirSync(join(root(), "templates"))
    .filter((name) => name.endsWith(".json") && name !== "schema.json")
    .sort();
  process.stdout.write(`${names.join("\n")}\n`);
}

async function liveModel(address: string, env: NodeJS.ProcessEnv): Promise<InspectModel> {
  const rpcUrl = env.SXP_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const source = env.SXP_SOURCE?.trim();
  const merchants = (env.SXP_MERCHANTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const merchantAllowlist = env.SXP_MERCHANT_ALLOWLIST?.trim();
  const kit = new SpendingPolicyKit({
    rpcUrl,
    networkPassphrase: networkPassphrase(env),
    sourceAccount: source !== undefined && source.length > 0 ? source : Keypair.random().publicKey(),
    ...(merchantAllowlist !== undefined && merchantAllowlist.length > 0 ? { merchantAllowlist } : {}),
    ...(merchants.length > 0 ? { merchants } : {}),
  });
  const base = contractAddressBase(address) ?? address;
  const report = await kit.inspect(base);
  const doc = loadDeployments(root());
  const names = policyNames(doc);
  const rules: RuleView[] = report.rules.map((rule) => ({
    id: rule.id,
    type: rule.type,
    ...(rule.contract !== undefined ? { contract: rule.contract } : {}),
    name: rule.name,
    ...(rule.validUntil !== undefined ? { validUntil: rule.validUntil } : {}),
    signers: rule.signers.map((signer) => ({
      kind: signer.kind,
      address: signer.address,
      ...(signer.verifier !== undefined ? { verifier: signer.verifier } : {}),
    })),
    policies: rule.policies.map((policy): PolicyView => {
      const name = names.get(policy);
      return name === undefined ? { address: policy, name: "unknown" } : { address: policy, name };
    }),
  }));
  const muxed = decodeMuxedContract(address);
  return {
    address,
    ...(muxed !== undefined && base !== address ? { baseAddress: base, muxId: muxed.id.toString() } : {}),
    ledger: report.ledger,
    rules,
    merchants: report.merchants.map((row) => ({
      merchant: row.merchant,
      remaining: row.remaining.toString(),
      allowed: row.allowed,
    })),
    ...(report.historyFill !== undefined ? { historyFill: report.historyFill } : {}),
    allowlist: eventAllowlist(doc),
  };
}

async function inspect(address: string | undefined, flags: Flags, env: NodeJS.ProcessEnv): Promise<void> {
  if (address === undefined || (!address.startsWith("C") && !address.startsWith("W"))) {
    fail("sxp inspect needs a C or W address");
  }
  const fixture = flags.values.get("fixture");
  const model =
    fixture !== undefined
      ? ({ ...(readJson(fixture) as InspectModel), address } as InspectModel)
      : await liveModel(address, env);
  if (address.startsWith("W")) {
    const muxed = decodeMuxedContract(address);
    const base = contractAddressBase(address);
    if (muxed !== undefined && base !== undefined) {
      model.baseAddress = base;
      model.muxId = muxed.id.toString();
    }
  }
  const rendered = renderInspect(model);
  process.stdout.write(`${flags.boolean.has("json") ? rendered.json : rendered.text}\n`);
}

async function fee(target: string | undefined, flags: Flags, env: NodeJS.ProcessEnv): Promise<void> {
  const account = flags.values.get("account");
  if (target === undefined || account === undefined || !account.startsWith("C")) {
    fail("sxp fee <url|requirements.json> --account C... is required");
  }
  const source = env.SXP_SOURCE?.trim() || flags.values.get("source");
  if (source === undefined) {
    fail("SXP_SOURCE or --source is required");
  }
  const kit = new SpendingPolicyKit({
    rpcUrl: env.SXP_RPC_URL?.trim() || "https://soroban-testnet.stellar.org",
    networkPassphrase: networkPassphrase(env),
    sourceAccount: source,
  });
  const requirements = target.startsWith("http")
    ? undefined
    : (readJson(target) as {
        asset: string;
        amount: string;
        payTo: string;
        scheme?: string;
        network?: string;
        maxTimeoutSeconds?: number;
      });
  if (requirements === undefined) {
    const response = await fetch(target, { headers: { accept: "application/json" } });
    if (response.status !== 402) {
      fail(`resource returned ${response.status}`);
    }
    const body = (await response.json()) as { accepts?: Array<{ asset: string; amount: string; payTo: string }> };
    const accepted = body.accepts?.[0];
    if (accepted === undefined) {
      fail("resource did not include payment requirements");
    }
    const estimate = await kit.estimateFee(accepted, account);
    process.stdout.write(`${JSON.stringify(estimate, null, 2)}\n`);
    return;
  }
  const estimate = await kit.estimateFee(requirements, account);
  process.stdout.write(`${JSON.stringify(estimate, null, 2)}\n`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const [command, sub, extra] = flags.positionals;
  if (command === "inspect") {
    await inspect(sub, flags, process.env);
    return;
  }
  if (command === "fee") {
    await fee(sub, flags, process.env);
    return;
  }
  if (command === "allowlist" && sub === "export") {
    exportAllowlist();
    return;
  }
  if (command === "templates" && sub === "list") {
    listTemplates();
    return;
  }
  if (command === "templates" && sub === "apply") {
    const params = flags.values.get("params");
    const account = flags.values.get("account");
    if (extra === undefined || params === undefined || account === undefined) {
      fail("sxp templates apply <template> --account C... --params p.json [--dry-run]");
    }
    if (!account.startsWith("C") && !account.startsWith("W")) {
      fail("--account must be a C or W address");
    }
    if (!flags.boolean.has("dry-run")) {
      fail("submitting a template needs the owner key; pass --dry-run to print the install XDR");
    }
    printTemplate(extra, params);
    return;
  }
  fail(
    "usage: sxp inspect <C|W> [--json] | sxp fee <url|file> --account C | sxp templates list|apply | sxp allowlist export",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "sxp failed";
  process.stderr.write(`${message.replace(/S[A-Z2-7]{55}/g, "[redacted]")}\n`);
  process.exit(1);
});
