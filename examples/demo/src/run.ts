/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testnet demo for the spending-policy kit. Keypairs are created in memory,
 * funded with Friendbot, and discarded on exit. Seeds are not printed or written.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import {
  compileTemplate,
  Ed25519Signer,
  signAuthEntry,
  type TemplateDocument,
} from "@stellar-x402-policies/sdk";
import { parseDiagnosticEvent } from "stellar-x402-policies";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = "stellar:testnet" as const;
const PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const ACCOUNT_WASM_HASH = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
const ED25519_VERIFIER = "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4";
const SPENDING_LIMIT = "CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5";
const MERCHANT_POLICY = "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6";
const PERIOD_POLICY = "CB2VQO2NYP4DJBPNCZGRGEUKIUCK7BJW66OXEPDHV7RJT2ICW23X3EL5";

const FUND_STROOPS = 50_000_000n;
const PAY_STROOPS = 1_000_000n;
const OVER_STROOPS = 1_500_000n;
const PERIOD_LEDGERS = 17_280;
const MAX_TIMEOUT_SECONDS = 300;
const FACILITATOR_PORT = 4021;
const INCLUSION_FEE_STROOPS = 100;

interface ChainTx {
  hash: string;
  feeCharged: number;
  ledger: number;
  url: string;
}

interface ToolResult {
  content?: Array<{ text?: string }>;
}

function log(step: string, detail: object = {}): void {
  console.log(JSON.stringify({ step, ...detail }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redact(text: string): string {
  return text.replace(/\bS[A-Z2-7]{55}\b/g, "[redacted-secret]");
}

function expertTx(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
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

function externalSigner(verifier: string, publicKey: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifier).toScVal(),
    xdr.ScVal.scvBytes(publicKey),
  ]);
}

function eventLabels(events: readonly xdr.DiagnosticEvent[]): string[] {
  return events.map((diagnostic) => {
    try {
      const view = parseDiagnosticEvent(diagnostic);
      const topic = view.topics[0];
      const name = typeof topic === "string" ? topic : view.type;
      return `${view.contractId ?? "diagnostic"}:${name}`;
    } catch {
      return "unparsed";
    }
  });
}

function requireSimulation(
  sim: rpc.Api.SimulateTransactionResponse,
  label: string,
): rpc.Api.SimulateTransactionSuccessResponse {
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`${label} simulation did not succeed`);
  }
  return sim;
}

function hostFunction(tx: Transaction): xdr.HostFunction {
  const operation = tx.operations[0];
  if (operation === undefined || operation.type !== "invokeHostFunction") {
    throw new Error("expected one invokeHostFunction operation");
  }
  return operation.func;
}

async function friendbot(publicKey: string): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
    if (response.ok) {
      await response.arrayBuffer();
      return;
    }
    last = `${response.status}`;
    await sleep(1_000 * attempt);
  }
  throw new Error(`Friendbot rejected ${publicKey} (${last})`);
}

async function waitForAccount(server: rpc.Server, publicKey: string): Promise<Account> {
  let last = "not found";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      return await server.getAccount(publicKey);
    } catch (error) {
      last = error instanceof Error ? error.message : "account lookup failed";
      await sleep(1_000);
    }
  }
  throw new Error(`RPC did not see ${publicKey}: ${last}`);
}

async function sendSigned(server: rpc.Server, tx: Transaction, label: string): Promise<ChainTx> {
  let sent: rpc.Api.SendTransactionResponse | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    sent = await server.sendTransaction(tx);
    if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
      break;
    }
    if (sent.status === "TRY_AGAIN_LATER" && attempt < 5) {
      await sleep(1_000 * attempt);
      continue;
    }
    const code = sent.errorResult?.result().switch().name ?? sent.status;
    throw new Error(`${label} was not accepted: ${code}`);
  }
  if (sent === undefined || (sent.status !== "PENDING" && sent.status !== "DUPLICATE")) {
    throw new Error(`${label} was not accepted`);
  }
  const polled = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (polled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    const topics =
      polled.status === rpc.Api.GetTransactionStatus.FAILED
        ? eventLabels(polled.diagnosticEventsXdr ?? []).join(", ")
        : "";
    throw new Error(
      `${label} ${polled.status} ${sent.hash}${topics.length > 0 ? ` events: ${topics}` : ""} ${expertTx(sent.hash)}`,
    );
  }
  return {
    hash: sent.hash,
    feeCharged: Number(polled.resultXdr.feeCharged()),
    ledger: polled.ledger,
    url: expertTx(sent.hash),
  };
}

async function submitSourceAccount(
  server: rpc.Server,
  source: Keypair,
  operation: xdr.Operation,
  label: string,
): Promise<ChainTx> {
  let last = "not submitted";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const account = await waitForAccount(server, source.publicKey());
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .addOperation(operation)
        .setTimeout(MAX_TIMEOUT_SECONDS)
        .build();
      const prepared = await server.prepareTransaction(tx);
      prepared.sign(source);
      return await sendSigned(server, prepared, label);
    } catch (error) {
      last = error instanceof Error ? error.message : "submit failed";
      if (!last.includes("txBadSeq") && !last.includes("TRY_AGAIN") && attempt > 1) {
        throw error;
      }
      if (!last.includes("txBadSeq") && !last.includes("TRY_AGAIN")) {
        throw error;
      }
      await sleep(1_000 * attempt);
    }
  }
  throw new Error(last);
}

async function submitAssembled(
  server: rpc.Server,
  source: Keypair,
  operation: xdr.Operation,
  simulation: rpc.Api.SimulateTransactionSuccessResponse,
  label: string,
): Promise<ChainTx> {
  let last = "not submitted";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const account = await waitForAccount(server, source.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(operation)
      .setTimeout(MAX_TIMEOUT_SECONDS)
      .build();
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(source);
    try {
      const sent = await sendSigned(server, prepared, label);
      await sleep(1_000);
      return sent;
    } catch (error) {
      last = error instanceof Error ? error.message : "submit failed";
      if (!last.includes("txBadSeq") && !last.includes("TRY_AGAIN")) {
        throw error;
      }
      await sleep(1_000 * attempt);
    }
  }
  throw new Error(last);
}

async function deployAccount(
  server: rpc.Server,
  owner: Keypair,
): Promise<{ contractId: string; tx: ChainTx }> {
  const tx = await submitSourceAccount(
    server,
    owner,
    Operation.createCustomContract({
      address: Address.fromString(owner.publicKey()),
      wasmHash: Buffer.from(ACCOUNT_WASM_HASH, "hex"),
      salt: randomBytes(32),
      constructorArgs: [
        xdr.ScVal.scvVec([externalSigner(ED25519_VERIFIER, Buffer.from(owner.rawPublicKey()))]),
        xdr.ScVal.scvMap([]),
      ],
    }),
    "deploy smart account",
  );
  const result = await server.getTransaction(tx.hash);
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS || result.returnValue === undefined) {
    throw new Error(`deploy ${tx.hash} did not return a contract id`);
  }
  return { contractId: Address.fromScVal(result.returnValue).toString(), tx };
}

async function fundAccount(
  server: rpc.Server,
  owner: Keypair,
  smartAccount: string,
  asset: string,
): Promise<ChainTx> {
  return submitSourceAccount(
    server,
    owner,
    new Contract(asset).call(
      "transfer",
      new Address(owner.publicKey()).toScVal(),
      new Address(smartAccount).toScVal(),
      i128(FUND_STROOPS),
    ),
    "fund smart account",
  );
}

function unsignedCall(
  source: Account,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}

async function installRule(
  server: rpc.Server,
  owner: Keypair,
  agent: Keypair,
  smartAccount: string,
  asset: string,
  merchantA: string,
): Promise<ChainTx> {
  const latest = await server.getLatestLedger();
  const template = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../templates/agent-merchant-allowlist.json", import.meta.url)), "utf8"),
  ) as TemplateDocument;
  const compiled = compileTemplate(template, {
    verifier: ED25519_VERIFIER,
    agent: agent.publicKey(),
    merchantA,
    spendingLimitContract: SPENDING_LIMIT,
    merchantAllowlistContract: MERCHANT_POLICY,
    xlm: asset,
    assetCap: 10_000_000,
    merchantCap: 3_000_000,
    perTxMax: 1_500_000,
    periodLedgers: PERIOD_LEDGERS,
    validUntil: latest.sequence + 200_000,
  });
  const rule = compiled.rules[0];
  if (rule === undefined) {
    throw new Error("template compiled no rules");
  }
  const args = xdr.ScVal.fromXDR(rule.installXdr, "base64").vec() ?? [];
  const account = await waitForAccount(server, owner.publicKey());
  const unsigned = unsignedCall(account, smartAccount, "add_context_rule", args);
  const recorded = requireSimulation(await server.simulateTransaction(unsigned), "add_context_rule");
  const entry = recorded.result?.auth?.[0];
  if (entry === undefined) {
    throw new Error("add_context_rule did not return an auth entry");
  }
  const signedEntry = await signAuthEntry(entry, {
    networkPassphrase: PASSPHRASE,
    expirationLedger: latest.sequence + 20,
    contextRuleId: 0,
    verifier: ED25519_VERIFIER,
    publicKey: Buffer.from(owner.rawPublicKey()),
    signer: new Ed25519Signer(owner),
    smartAccount,
  });
  const withAuth = unsignedCall(account, smartAccount, "add_context_rule", args);
  const operation = Operation.invokeHostFunction({ func: hostFunction(withAuth), auth: [signedEntry] });
  const rebuilt = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  const enforced = requireSimulation(await server.simulateTransaction(rebuilt), "add_context_rule auth");
  return submitAssembled(server, owner, operation, enforced, "install merchant allowlist");
}

async function buildSignedPayment(input: {
  server: rpc.Server;
  source: Keypair;
  agent: Keypair;
  smartAccount: string;
  merchant: string;
  asset: string;
  amount: bigint;
  contextRuleId: number;
}): Promise<{ transaction: string; minResourceFee: number; events: string[] }> {
  const account = await waitForAccount(input.server, input.source.publicKey());
  const unsigned = unsignedCall(account, input.asset, "transfer", [
    new Address(input.smartAccount).toScVal(),
    new Address(input.merchant).toScVal(),
    i128(input.amount),
  ]);
  const recorded = requireSimulation(await input.server.simulateTransaction(unsigned), "payment");
  const entry = recorded.result?.auth?.[0];
  if (entry === undefined) {
    throw new Error("payment simulation did not return an auth entry");
  }
  const latest = await input.server.getLatestLedger();
  const signedEntry = await signAuthEntry(entry, {
    networkPassphrase: PASSPHRASE,
    expirationLedger: latest.sequence + 20,
    contextRuleId: input.contextRuleId,
    verifier: ED25519_VERIFIER,
    publicKey: Buffer.from(input.agent.rawPublicKey()),
    signer: new Ed25519Signer(input.agent),
    smartAccount: input.smartAccount,
  });
  const rebuilt = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: hostFunction(unsigned), auth: [signedEntry] }))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  const enforced = requireSimulation(await input.server.simulateTransaction(rebuilt), "payment auth");
  return {
    transaction: rebuilt.toXDR(),
    minResourceFee: Number(enforced.minResourceFee),
    events: eventLabels(enforced.events),
  };
}

async function referenceRejection(
  scheme: ExactStellarScheme,
  transaction: string,
  requirements: PaymentRequirements,
): Promise<{ invalidReason: string; invalidMessage?: string }> {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction },
  };
  const verified: VerifyResponse = await scheme.verify(payload, requirements);
  if (verified.isValid) {
    throw new Error("ExactStellarScheme accepted the smart-account payment");
  }
  return {
    invalidReason: verified.invalidReason ?? "unknown",
    ...(verified.invalidMessage !== undefined ? { invalidMessage: verified.invalidMessage } : {}),
  };
}

function listenResource(payTo: string, asset: string): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const amount = url.searchParams.get("amount") ?? PAY_STROOPS.toString();
    const body = JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          asset,
          amount,
          payTo,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: {},
        },
      ],
    });
    response.writeHead(402, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("resource server failed to bind");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.close();
        },
      });
    });
  });
}

class McpSession {
  private buffer = "";
  private nextId = 0;
  private readonly waiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const pending = new Promise<unknown>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return pending;
  }

  notify(method: string): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.child.kill("SIGTERM");
  }

  private drain(): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id !== "number") {
        continue;
      }
      const waiter = this.waiters.get(message.id);
      if (waiter === undefined) {
        continue;
      }
      this.waiters.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? "mcp error"));
      } else {
        waiter.resolve(message.result);
      }
    }
  }
}

function toolJson(result: unknown): Record<string, unknown> {
  const text = ((result as ToolResult).content ?? []).map((item) => item.text ?? "").join("\n");
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error(`tool result had no JSON: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

function startMcp(env: NodeJS.ProcessEnv): McpSession {
  const entry = fileURLToPath(new URL("../../../packages/mcp/dist/stdio.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { env, stdio: ["pipe", "pipe", "pipe"] });
  return new McpSession(child);
}

async function sxpInspect(account: string, source: string, merchant: string): Promise<string> {
  const entry = fileURLToPath(new URL("../../../packages/inspector/dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "inspect", account, "--json"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SXP_NETWORK: "testnet",
      SXP_RPC_URL: RPC_URL,
      SXP_SOURCE: source,
      SXP_MERCHANT_ALLOWLIST: MERCHANT_POLICY,
      SXP_MERCHANTS: merchant,
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  const text = Buffer.concat(stdout).toString("utf8");
  if (code !== 0) {
    throw new Error(`sxp inspect exited ${code}: ${redact(Buffer.concat(stderr).toString("utf8")).slice(0, 500)}`);
  }
  return text.trim();
}

function facilitatorEnv(secret: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SSL_CERT_FILE"]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.STELLAR_NETWORK = NETWORK;
  env.STELLAR_RPC_URL = RPC_URL;
  env.FACILITATOR_SECRET_KEY = secret;
  env.POLICY_CONTRACT_IDS = [SPENDING_LIMIT, MERCHANT_POLICY, PERIOD_POLICY].join(",");
  env.POLICY_EVENT_TOPICS = "spending_limit_enforced,merchant_cap_enforced,period_cap_enforced";
  env.FEE_PROFILE = "cold";
  env.HOST = "127.0.0.1";
  env.PORT = String(FACILITATOR_PORT);
  return env;
}

async function startFacilitator(secret: string): Promise<ChildProcess> {
  const entry = fileURLToPath(new URL("../../facilitator/dist/server.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env: facilitatorEnv(secret),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    output = redact(`${output}${chunk.toString("utf8")}`).slice(-4_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`facilitator exited ${child.exitCode}: ${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${FACILITATOR_PORT}/health`);
      if (response.ok) {
        return child;
      }
    } catch {
      // Still binding.
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`facilitator did not become healthy: ${output}`);
}

interface RawSim {
  error?: string;
  transactionData?: string;
  minResourceFee?: string;
  results?: Array<{ auth?: string[] }>;
}

async function simulateRaw(tx: Transaction): Promise<RawSim> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: { transaction: tx.toXDR() },
    }),
  });
  const body = (await response.json()) as { error?: { message?: string }; result?: RawSim };
  if (body.result === undefined) {
    throw new Error(body.error?.message ?? "simulateTransaction returned no result");
  }
  return body.result;
}

function manualAuth(smartAccount: string, asset: string, merchant: string, amount: bigint): xdr.SorobanAuthorizationEntry {
  const nonce = BigInt(`0x${randomBytes(6).toString("hex")}`);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(smartAccount).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(asset).toScAddress(),
          functionName: "transfer",
          args: [new Address(smartAccount).toScVal(), new Address(merchant).toScVal(), i128(amount)],
        }),
      ),
      subInvocations: [],
    }),
  });
}

async function forcePanic(input: {
  server: rpc.Server;
  owner: Keypair;
  agent: Keypair;
  smartAccount: string;
  merchant: string;
  asset: string;
}): Promise<{ hash: string; status: string; feeCharged: number; detail: string; url: string }> {
  const account = await waitForAccount(input.server, input.owner.publicKey());
  const unsigned = unsignedCall(account, input.asset, "transfer", [
    new Address(input.smartAccount).toScVal(),
    new Address(input.merchant).toScVal(),
    i128(PAY_STROOPS),
  ]);
  const raw = await simulateRaw(unsigned);
  const encoded = raw.results?.[0]?.auth?.[0];
  const template =
    encoded !== undefined
      ? xdr.SorobanAuthorizationEntry.fromXDR(encoded, "base64")
      : manualAuth(input.smartAccount, input.asset, input.merchant, PAY_STROOPS);
  const latest = await input.server.getLatestLedger();
  const signed = await signAuthEntry(template, {
    networkPassphrase: PASSPHRASE,
    expirationLedger: latest.sequence + 20,
    contextRuleId: 1,
    verifier: ED25519_VERIFIER,
    publicKey: Buffer.from(input.agent.rawPublicKey()),
    signer: new Ed25519Signer(input.agent),
    smartAccount: input.smartAccount,
  });
  if (raw.transactionData === undefined) {
    throw new Error(`panic simulation had no footprint: ${raw.error ?? "no error"}`);
  }
  const fee = String(Number(raw.minResourceFee ?? "0") + INCLUSION_FEE_STROOPS + 10_000);
  const fresh = await waitForAccount(input.server, input.owner.publicKey());
  const tx = new TransactionBuilder(fresh, { fee, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: hostFunction(unsigned), auth: [signed] }))
    .setSorobanData(xdr.SorobanTransactionData.fromXDR(raw.transactionData, "base64"))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  tx.sign(input.owner);
  const enforced = await simulateRaw(tx);
  const sent = await input.server.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    const code = sent.errorResult?.result().switch().name ?? sent.status;
    throw new Error(`force-submit was not accepted: ${code}`);
  }
  const polled = await input.server.pollTransaction(sent.hash, { attempts: 40 });
  const topics =
    polled.status === rpc.Api.GetTransactionStatus.FAILED
      ? eventLabels(polled.diagnosticEventsXdr ?? []).join(", ")
      : "";
  const feeCharged =
    polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND
      ? 0
      : Number(polled.resultXdr.feeCharged());
  return {
    hash: sent.hash,
    status: polled.status,
    feeCharged,
    detail: `signed simulation: ${enforced.error ?? "none"}; on-chain: ${polled.status}${topics.length > 0 ? ` (${topics})` : ""}`.trim(),
    url: expertTx(sent.hash),
  };
}

function requirements(asset: string, merchant: string, amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset,
    amount: amount.toString(),
    payTo: merchant,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {},
  };
}

async function main(): Promise<void> {
  const server = new rpc.Server(RPC_URL, { allowHttp: false });
  const asset = Asset.native().contractId(PASSPHRASE);
  const owner = Keypair.random();
  const agent = Keypair.random();
  const merchantA = Keypair.random();
  const merchantB = Keypair.random();
  const facilitatorKey = Keypair.random();
  log("keys", {
    owner: owner.publicKey(),
    agent: agent.publicKey(),
    merchantA: merchantA.publicKey(),
    merchantB: merchantB.publicKey(),
    facilitator: facilitatorKey.publicKey(),
    asset,
    accountWasm: ACCOUNT_WASM_HASH,
  });
  for (const key of [owner, agent, merchantA, merchantB, facilitatorKey]) {
    await friendbot(key.publicKey());
  }
  log("funded", { via: "friendbot" });

  const deployed = await deployAccount(server, owner);
  log("deployed", { smartAccount: deployed.contractId, ...deployed.tx });
  const funded = await fundAccount(server, owner, deployed.contractId, asset);
  log("wallet-funded", funded);
  const installed = await installRule(
    server,
    owner,
    agent,
    deployed.contractId,
    asset,
    merchantA.publicKey(),
  );
  log("installed", installed);

  const inspectBefore = await sxpInspect(deployed.contractId, owner.publicKey(), merchantA.publicKey());
  log("inspect-before", { bytes: inspectBefore.length });

  const coldBuilt = await buildSignedPayment({
    server,
    source: owner,
    agent,
    smartAccount: deployed.contractId,
    merchant: merchantA.publicKey(),
    asset,
    amount: PAY_STROOPS,
    contextRuleId: 1,
  });
  const firstRequirements = requirements(asset, merchantA.publicKey(), PAY_STROOPS);
  const signer = createEd25519Signer(facilitatorKey.secret(), NETWORK);
  const reference = new ExactStellarScheme([signer], { rpcConfig: { url: RPC_URL } });
  const raised = new ExactStellarScheme([signer], {
    rpcConfig: { url: RPC_URL },
    maxTransactionFeeStroops: Math.max(coldBuilt.minResourceFee + INCLUSION_FEE_STROOPS, 50_000_000),
  });
  const defaultRejection = await referenceRejection(reference, coldBuilt.transaction, firstRequirements);
  const eventRejection = await referenceRejection(raised, coldBuilt.transaction, firstRequirements);
  log("reference", { defaultRejection, eventRejection, simulated: coldBuilt.minResourceFee + INCLUSION_FEE_STROOPS });

  const resourceA = await listenResource(merchantA.publicKey(), asset);
  const resourceB = await listenResource(merchantB.publicKey(), asset);
  const facilitator = await startFacilitator(facilitatorKey.secret());
  const mcpEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SXP_ACCOUNT: deployed.contractId,
    SXP_AGENT_SECRET: agent.secret(),
    SXP_RPC_URL: RPC_URL,
    SXP_FACILITATOR_URL: `http://127.0.0.1:${FACILITATOR_PORT}`,
    SXP_NETWORK: "testnet",
    SXP_VERIFIER: ED25519_VERIFIER,
    SXP_SOURCE: agent.publicKey(),
    SXP_MERCHANT_ALLOWLIST: MERCHANT_POLICY,
  };
  const mcp = startMcp(mcpEnv);
  try {
    await mcp.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "sxp-demo", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized");
    const inspected = toolJson(
      await mcp.request("tools/call", {
        name: "inspect_account",
        arguments: { address: deployed.contractId },
      }),
    );
    log("mcp-inspect", { rules: Array.isArray(inspected.rules) ? inspected.rules.length : 0 });

    const pay = async (url: string, amount: string): Promise<Record<string, unknown>> =>
      toolJson(
        await mcp.request("tools/call", {
          name: "pay",
          arguments: { url: `${url}/?amount=${amount}`, max_amount: "2000000" },
        }),
      );

    const cold = await pay(resourceA.url, PAY_STROOPS.toString());
    log("pay-cold", cold);
    const warm = await pay(resourceA.url, PAY_STROOPS.toString());
    log("pay-warm", warm);
    const over = await pay(resourceA.url, OVER_STROOPS.toString());
    log("pay-over", over);
    const blocked = await pay(resourceB.url, PAY_STROOPS.toString());
    log("pay-blocked", blocked);
    const forced = await forcePanic({
      server,
      owner,
      agent,
      smartAccount: deployed.contractId,
      merchant: merchantB.publicKey(),
      asset,
    });
    log("force", forced);
    const inspectAfter = await sxpInspect(deployed.contractId, owner.publicKey(), merchantA.publicKey());

    const coldHash = String(cold.txHash ?? "");
    const warmHash = String(warm.txHash ?? "");
    const coldChain = coldHash.length > 0 ? await server.getTransaction(coldHash) : undefined;
    const warmChain = warmHash.length > 0 ? await server.getTransaction(warmHash) : undefined;
    const feeOf = (chain: rpc.Api.GetTransactionResponse | undefined): { charged: string; bid: string } => {
      if (chain === undefined || chain.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        return { charged: "", bid: "" };
      }
      const parsed = TransactionBuilder.fromXDR(chain.envelopeXdr, PASSPHRASE);
      const inner = "innerTransaction" in parsed ? parsed.innerTransaction : parsed;
      return { charged: String(Number(chain.resultXdr.feeCharged())), bid: inner.fee };
    };
    const coldFee = feeOf(coldChain);
    const warmFee = feeOf(warmChain);
    const lines = [
      "# Kit testnet run",
      "",
      `Live run on ${new Date().toISOString().slice(0, 10)}. Friendbot funded the owner, the agent, two merchants, and the facilitator. Seeds stayed in process memory.`,
      "",
      "| Role | Address |",
      "| --- | --- |",
      `| Smart account | \`${deployed.contractId}\` |`,
      `| Owner | \`${owner.publicKey()}\` |`,
      `| Agent | \`${agent.publicKey()}\` |`,
      `| Merchant A (allowlisted, 0.3 XLM/day, 0.15 XLM/tx) | \`${merchantA.publicKey()}\` |`,
      `| Merchant B (not listed) | \`${merchantB.publicKey()}\` |`,
      `| Facilitator | \`${facilitatorKey.publicKey()}\` |`,
      "",
      `Account WASM \`${ACCOUNT_WASM_HASH}\`. Verifier \`${ED25519_VERIFIER}\`. \`spending_limit\` \`${SPENDING_LIMIT}\` (1 XLM/day). \`merchant-allowlist\` \`${MERCHANT_POLICY}\`. \`period-cap\` \`${PERIOD_POLICY}\` is on the verifier allowlist and is not installed by this template.`,
      "",
      "## Setup",
      "",
      `| Step | Fee charged | Transaction |`,
      `| --- | ---: | --- |`,
      `| Deploy account | ${deployed.tx.feeCharged} | [${deployed.tx.hash}](${deployed.tx.url}) |`,
      `| Fund 5 XLM | ${funded.feeCharged} | [${funded.hash}](${funded.url}) |`,
      `| Install rules | ${installed.feeCharged} | [${installed.hash}](${installed.url}) |`,
      "",
      "## Reference scheme",
      "",
      `A signed 0.1 XLM payment to merchant A (simulated settlement fee ${coldBuilt.minResourceFee + INCLUSION_FEE_STROOPS} stroops) was rejected by stock \`ExactStellarScheme\` before the MCP payments.`,
      "",
      `| Ceiling | Reason |`,
      `| --- | --- |`,
      `| Default | \`${defaultRejection.invalidReason}\` |`,
      `| Raised above the simulated fee | \`${eventRejection.invalidReason}\` |`,
      "",
      ...(defaultRejection.invalidMessage !== undefined
        ? [`Default message: ${defaultRejection.invalidMessage}`, ""]
        : []),
      ...(eventRejection.invalidMessage !== undefined
        ? [`Raised-ceiling message: ${eventRejection.invalidMessage}`, ""]
        : []),
      "## MCP payments",
      "",
      "Pays went through the stdio MCP server. The fee bid is the facilitator envelope fee. The charged fee is what the network kept.",
      "",
      "| Step | Result | Fee charged | Fee bid | Transaction |",
      "| --- | --- | ---: | ---: | --- |",
      `| A 0.1 XLM cold | ${cold.txHash === undefined ? JSON.stringify(cold) : "settled"} | ${coldFee.charged || cold.feeCharged || ""} | ${coldFee.bid} | ${coldHash.length === 0 ? "" : `[${coldHash}](${expertTx(coldHash)})`} |`,
      `| A 0.1 XLM warm | ${warm.txHash === undefined ? JSON.stringify(warm) : "settled"} | ${warmFee.charged || warm.feeCharged || ""} | ${warmFee.bid} | ${warmHash.length === 0 ? "" : `[${warmHash}](${expertTx(warmHash)})`} |`,
      `| A 0.15 XLM | \`${String(over.status ?? "")} ${String(over.reason ?? over.message ?? "")}\` | | | |`,
      `| B 0.1 XLM precheck | \`${String(blocked.status ?? "")} ${String(blocked.reason ?? blocked.message ?? "")}\` | | | |`,
      `| B 0.1 XLM force-submit | ${forced.status} ${forced.detail} | ${forced.feeCharged} | | [${forced.hash}](${forced.url}) |`,
      "",
      "## sxp inspect before",
      "",
      "```json",
      inspectBefore,
      "```",
      "",
      "## sxp inspect after",
      "",
      "```json",
      inspectAfter,
      "```",
      "",
    ];
    const path = fileURLToPath(new URL("../../../docs/testnet-results-kit.md", import.meta.url));
    writeFileSync(path, lines.join("\n"));
    log("wrote", { path, cold: coldHash, warm: warmHash, forced: forced.hash });
  } finally {
    mcp.close();
    facilitator.kill("SIGTERM");
    resourceA.close();
    resourceB.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : "demo failed";
  console.error(redact(message));
  process.exitCode = 1;
});
