/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end Stellar testnet run. Keypairs are generated in memory, funded
 * with Friendbot, and discarded when the process exits. Nothing is written
 * to .env and no seed is printed.
 *
 * The script deploys an OpenZeppelin stellar-accounts instance with a
 * spending_limit policy, shows ExactStellarScheme rejecting the payment,
 * then settles it twice through examples/facilitator.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { DEFAULT_COLD_FEE_CAP_STROOPS, parseDiagnosticEvent } from "stellar-x402-policies";

import {
  ACCOUNT_WASM_HASH,
  authEntryAddress,
  callContractRule,
  DEFAULT_RULE_ID,
  ED25519_VERIFIER,
  emptyPolicyMap,
  policyInstallMap,
  signSmartAccountEntry,
  signerList,
  SPENDING_LIMIT_POLICY,
  SPENDING_RULE_ID,
  spendingLimitParams,
} from "./oz-account.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = "stellar:testnet" as const;
const PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const FUND_STROOPS = 50_000_000n;
const SPENDING_LIMIT_STROOPS = 10_000_000n;
const PAYMENT_STROOPS = 1_000_000n;
const PERIOD_LEDGERS = 17_280;
const MAX_TIMEOUT_SECONDS = 300;
const SIGNATURE_EXPIRATION_LEDGERS = 20;
const INCLUSION_FEE_STROOPS = 100;
const FACILITATOR_PORT = 4021;

interface ChainTx {
  hash: string;
  feeCharged: number;
  ledger: number;
  url: string;
}

interface PaymentRun extends ChainTx {
  label: "cold" | "warm";
  minResourceFee: number;
  settlementFee: number;
  events: string[];
}

interface ReferenceRejection {
  invalidReason: string;
  invalidMessage?: string;
  payer?: string;
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

function xlm(stroops: number | bigint): string {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  const rendered = frac.length === 0 ? `${whole}` : `${whole}.${frac}`;
  return negative ? `-${rendered}` : rendered;
}

function eventLabels(events: readonly xdr.DiagnosticEvent[]): string[] {
  const labels: string[] = [];
  for (const diagnostic of events) {
    try {
      const view = parseDiagnosticEvent(diagnostic);
      const topic = view.topics[0];
      const name = typeof topic === "string" ? topic : view.type;
      labels.push(`${view.contractId ?? "diagnostic"}:${name}`);
    } catch {
      labels.push("unparsed");
    }
  }
  return labels;
}

function requireSimulation(
  sim: rpc.Api.SimulateTransactionResponse,
  label: string,
): rpc.Api.SimulateTransactionSuccessResponse {
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Error(`${label} needs archived ledger entries restored before it can run`);
  }
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`${label} simulation did not succeed`);
  }
  return sim;
}

async function friendbot(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url);
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

async function sendSigned(
  server: rpc.Server,
  tx: Transaction,
  label: string,
): Promise<ChainTx> {
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
  const account = await waitForAccount(server, source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(source);
  return sendSigned(server, prepared, label);
}

function rebuild(
  publicKey: string,
  sequence: string,
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
): Transaction {
  return new TransactionBuilder(new Account(publicKey, sequence), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}

function invokeFunction(tx: Transaction): xdr.HostFunction {
  const operation = tx.operations[0];
  if (operation === undefined || operation.type !== "invokeHostFunction") {
    throw new Error("expected one invokeHostFunction operation");
  }
  return operation.func;
}

async function assertPublishedContracts(server: rpc.Server): Promise<void> {
  const wasmKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(ACCOUNT_WASM_HASH, "hex") }),
  );
  const instanceKey = (contractId: string): xdr.LedgerKey =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  const found = await server.getLedgerEntries(
    wasmKey,
    instanceKey(ED25519_VERIFIER),
    instanceKey(SPENDING_LIMIT_POLICY),
  );
  if (found.entries.length !== 3) {
    throw new Error(
      `testnet is missing the published account WASM or a singleton (${found.entries.length} of 3 entries)`,
    );
  }
}

async function deployAccount(
  server: rpc.Server,
  deployer: Keypair,
  agent: Keypair,
): Promise<{ contractId: string; tx: ChainTx }> {
  const tx = await submitSourceAccount(
    server,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.from(ACCOUNT_WASM_HASH, "hex"),
      salt: randomBytes(32),
      constructorArgs: [
        signerList(ED25519_VERIFIER, Buffer.from(agent.rawPublicKey())),
        emptyPolicyMap(),
      ],
    }),
    "deploy smart account",
  );
  const result = await server.getTransaction(tx.hash);
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS || result.returnValue === undefined) {
    throw new Error(`deploy ${tx.hash} did not return a contract id`);
  }
  const contractId = Address.fromScVal(result.returnValue).toString();
  return { contractId, tx };
}

async function fundAccount(
  server: rpc.Server,
  deployer: Keypair,
  smartAccount: string,
  asset: string,
): Promise<ChainTx> {
  const token = new Contract(asset);
  return submitSourceAccount(
    server,
    deployer,
    token.call(
      "transfer",
      Address.fromString(deployer.publicKey()).toScVal(),
      Address.fromString(smartAccount).toScVal(),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString("0"),
          lo: xdr.Uint64.fromString(FUND_STROOPS.toString()),
        }),
      ),
    ),
    "fund smart account",
  );
}

async function addSpendingRule(
  server: rpc.Server,
  deployer: Keypair,
  agent: Keypair,
  smartAccount: string,
  asset: string,
): Promise<ChainTx> {
  const account = await waitForAccount(server, deployer.publicKey());
  const sequence = account.sequenceNumber();
  const call = new Contract(smartAccount).call(
    "add_context_rule",
    callContractRule(asset),
    xdr.ScVal.scvString("spend"),
    xdr.ScVal.scvVoid(),
    signerList(ED25519_VERIFIER, Buffer.from(agent.rawPublicKey())),
    policyInstallMap(
      SPENDING_LIMIT_POLICY,
      spendingLimitParams(SPENDING_LIMIT_STROOPS, PERIOD_LEDGERS),
    ),
  );
  const unsigned = new TransactionBuilder(new Account(deployer.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(call)
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  const recorded = requireSimulation(
    await server.simulateTransaction(unsigned),
    "add_context_rule",
  );
  const template = recorded.result?.auth ?? [];
  if (template.length !== 1) {
    throw new Error(`add_context_rule returned ${template.length} auth entries`);
  }
  const entry = template[0];
  if (entry === undefined) {
    throw new Error("add_context_rule auth entry was missing");
  }
  const latest = await server.getLatestLedger();
  const signedEntry = signSmartAccountEntry(entry, {
    networkPassphrase: PASSPHRASE,
    expirationLedger: latest.sequence + SIGNATURE_EXPIRATION_LEDGERS,
    contextRuleId: DEFAULT_RULE_ID,
    verifier: ED25519_VERIFIER,
    signer: agent,
    smartAccount,
  });
  const withAuth = rebuild(deployer.publicKey(), sequence, invokeFunction(unsigned), [signedEntry]);
  const enforced = requireSimulation(
    await server.simulateTransaction(withAuth),
    "add_context_rule auth",
  );
  const prepared = rpc.assembleTransaction(withAuth, enforced).build();
  prepared.sign(deployer);
  return sendSigned(server, prepared, "install spending limit");
}

async function buildPayment(input: {
  server: rpc.Server;
  deployer: Keypair;
  agent: Keypair;
  smartAccount: string;
  merchant: string;
  asset: string;
}): Promise<{ transaction: string; minResourceFee: number; events: string[] }> {
  const account = await waitForAccount(input.server, input.deployer.publicKey());
  const sequence = account.sequenceNumber();
  const call = new Contract(input.asset).call(
    "transfer",
    Address.fromString(input.smartAccount).toScVal(),
    Address.fromString(input.merchant).toScVal(),
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString("0"),
        lo: xdr.Uint64.fromString(PAYMENT_STROOPS.toString()),
      }),
    ),
  );
  const unsigned = new TransactionBuilder(new Account(input.deployer.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(call)
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
  const recorded = requireSimulation(await input.server.simulateTransaction(unsigned), "payment");
  const template = recorded.result?.auth ?? [];
  if (template.length !== 1) {
    const addresses = template.map((entry) => authEntryAddress(entry) ?? "source-account");
    throw new Error(`payment simulation returned auth entries: ${addresses.join(", ")}`);
  }
  const entry = template[0];
  if (entry === undefined) {
    throw new Error("payment auth entry was missing");
  }
  const latest = await input.server.getLatestLedger();
  const signedEntry = signSmartAccountEntry(entry, {
    networkPassphrase: PASSPHRASE,
    expirationLedger: latest.sequence + SIGNATURE_EXPIRATION_LEDGERS,
    contextRuleId: SPENDING_RULE_ID,
    verifier: ED25519_VERIFIER,
    signer: input.agent,
    smartAccount: input.smartAccount,
  });
  const withAuth = rebuild(
    input.deployer.publicKey(),
    sequence,
    invokeFunction(unsigned),
    [signedEntry],
  );
  const enforced = requireSimulation(
    await input.server.simulateTransaction(withAuth),
    "payment auth",
  );
  return {
    transaction: withAuth.toXDR(),
    minResourceFee: Number(enforced.minResourceFee),
    events: eventLabels(enforced.events),
  };
}

function paymentRequirements(asset: string, merchant: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset,
    amount: PAYMENT_STROOPS.toString(),
    payTo: merchant,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {},
  };
}

async function referenceRejection(
  scheme: ExactStellarScheme,
  transaction: string,
  requirements: PaymentRequirements,
): Promise<ReferenceRejection> {
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
    ...(verified.payer !== undefined ? { payer: verified.payer } : {}),
  };
}

function facilitatorEnv(secret: string, cap: number | undefined): NodeJS.ProcessEnv {
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
  env.POLICY_CONTRACT_IDS = SPENDING_LIMIT_POLICY;
  env.POLICY_EVENT_TOPICS = "spending_limit_enforced";
  env.FEE_PROFILE = "cold";
  env.HOST = "127.0.0.1";
  env.PORT = String(FACILITATOR_PORT);
  if (cap !== undefined) {
    env.COLD_FEE_CAP_STROOPS = String(cap);
  }
  return env;
}

async function startFacilitator(secret: string, cap: number | undefined): Promise<ChildProcess> {
  const entry = fileURLToPath(new URL("../../facilitator/dist/server.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env: facilitatorEnv(secret, cap),
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
        log("facilitator", { port: FACILITATOR_PORT, log: output.trim() });
        return child;
      }
    } catch {
      // The process is still binding the port.
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`facilitator did not become healthy: ${output}`);
}

async function postJson(path: "/verify" | "/settle", body: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${FACILITATOR_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${redact(text).slice(0, 500)}`);
  }
  return parsed;
}

async function settlePayment(
  server: rpc.Server,
  label: "cold" | "warm",
  transaction: string,
  requirements: PaymentRequirements,
  minResourceFee: number,
  events: string[],
): Promise<PaymentRun> {
  const body = {
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction },
    },
    paymentRequirements: requirements,
  };
  const verified = (await postJson("/verify", body)) as {
    isValid?: boolean;
    invalidReason?: string;
    invalidMessage?: string;
  };
  if (verified.isValid !== true) {
    throw new Error(
      `${label} verify rejected the payment: ${verified.invalidReason ?? "unknown"} ${verified.invalidMessage ?? ""}`.trim(),
    );
  }
  const settled = (await postJson("/settle", body)) as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
  };
  if (settled.success !== true || settled.transaction === undefined || settled.transaction.length === 0) {
    throw new Error(`${label} settle failed: ${settled.errorReason ?? "no transaction hash"}`);
  }
  const result = await server.getTransaction(settled.transaction);
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label} settlement ${settled.transaction} is ${result.status}`);
  }
  return {
    label,
    hash: settled.transaction,
    feeCharged: Number(result.resultXdr.feeCharged()),
    ledger: result.ledger,
    url: expertTx(settled.transaction),
    minResourceFee,
    settlementFee: minResourceFee + INCLUSION_FEE_STROOPS,
    events,
  };
}

async function main(): Promise<void> {
  const server = new rpc.Server(RPC_URL, { allowHttp: false });
  await assertPublishedContracts(server);
  const asset = Asset.native().contractId(PASSPHRASE);
  const deployer = Keypair.random();
  const facilitator = Keypair.random();
  const merchant = Keypair.random();
  const agent = Keypair.random();

  log("keys", {
    deployer: deployer.publicKey(),
    facilitator: facilitator.publicKey(),
    merchant: merchant.publicKey(),
    agent: agent.publicKey(),
    asset,
    accountWasm: ACCOUNT_WASM_HASH,
    ed25519Verifier: ED25519_VERIFIER,
    spendingLimitPolicy: SPENDING_LIMIT_POLICY,
  });

  await Promise.all([
    friendbot(deployer.publicKey()),
    friendbot(facilitator.publicKey()),
    friendbot(merchant.publicKey()),
  ]);
  log("funded", { via: "friendbot" });

  const deployed = await deployAccount(server, deployer, agent);
  log("deployed", { smartAccount: deployed.contractId, ...deployed.tx });
  const funded = await fundAccount(server, deployer, deployed.contractId, asset);
  log("wallet-funded", { amount: xlm(FUND_STROOPS), ...funded });
  const rule = await addSpendingRule(server, deployer, agent, deployed.contractId, asset);
  log("rule", {
    contextRuleId: SPENDING_RULE_ID,
    spendingLimit: xlm(SPENDING_LIMIT_STROOPS),
    periodLedgers: PERIOD_LEDGERS,
    ...rule,
  });

  const coldPayment = await buildPayment({
    server,
    deployer,
    agent,
    smartAccount: deployed.contractId,
    merchant: merchant.publicKey(),
    asset,
  });
  log("cold-simulation", {
    minResourceFee: coldPayment.minResourceFee,
    settlementFee: coldPayment.minResourceFee + INCLUSION_FEE_STROOPS,
    events: coldPayment.events,
  });
  if (!coldPayment.events.some((label) => label.endsWith(":spending_limit_enforced"))) {
    throw new Error(
      `enforced simulation did not emit spending_limit_enforced (${coldPayment.events.join(", ")})`,
    );
  }

  const requirements = paymentRequirements(asset, merchant.publicKey());
  const signer = createEd25519Signer(facilitator.secret(), NETWORK);
  const reference = new ExactStellarScheme([signer], { rpcConfig: { url: RPC_URL } });
  const raisedCap = Math.max(coldPayment.minResourceFee + INCLUSION_FEE_STROOPS, 50_000_000);
  const raised = new ExactStellarScheme([signer], {
    rpcConfig: { url: RPC_URL },
    maxTransactionFeeStroops: raisedCap,
  });
  const defaultRejection = await referenceRejection(reference, coldPayment.transaction, requirements);
  const eventRejection = await referenceRejection(raised, coldPayment.transaction, requirements);
  log("reference", { defaultCeiling: defaultRejection, raisedCeiling: eventRejection });

  const settlementFee = coldPayment.minResourceFee + INCLUSION_FEE_STROOPS;
  const coldCap =
    settlementFee > DEFAULT_COLD_FEE_CAP_STROOPS
      ? Math.max(DEFAULT_COLD_FEE_CAP_STROOPS, settlementFee * 2)
      : undefined;
  const child = await startFacilitator(facilitator.secret(), coldCap);
  try {
    const cold = await settlePayment(
      server,
      "cold",
      coldPayment.transaction,
      requirements,
      coldPayment.minResourceFee,
      coldPayment.events,
    );
    log("settled", cold);

    const warmPayment = await buildPayment({
      server,
      deployer,
      agent,
      smartAccount: deployed.contractId,
      merchant: merchant.publicKey(),
      asset,
    });
    log("warm-simulation", {
      minResourceFee: warmPayment.minResourceFee,
      settlementFee: warmPayment.minResourceFee + INCLUSION_FEE_STROOPS,
      events: warmPayment.events,
    });
    const warm = await settlePayment(
      server,
      "warm",
      warmPayment.transaction,
      requirements,
      warmPayment.minResourceFee,
      warmPayment.events,
    );
    log("settled", warm);

    log("result", {
      network: NETWORK,
      rpc: RPC_URL,
      asset,
      smartAccount: deployed.contractId,
      deployer: deployer.publicKey(),
      facilitator: facilitator.publicKey(),
      merchant: merchant.publicKey(),
      agent: agent.publicKey(),
      accountWasm: ACCOUNT_WASM_HASH,
      ed25519Verifier: ED25519_VERIFIER,
      spendingLimitPolicy: SPENDING_LIMIT_POLICY,
      spendingLimitStroops: SPENDING_LIMIT_STROOPS.toString(),
      paymentStroops: PAYMENT_STROOPS.toString(),
      coldCapStroops: coldCap ?? DEFAULT_COLD_FEE_CAP_STROOPS,
      setup: { deploy: deployed.tx, fund: funded, rule },
      reference: { defaultCeiling: defaultRejection, raisedCeiling: eventRejection },
      settlements: { cold, warm },
    });
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Live testnet run failed";
  console.error(redact(message));
  process.exitCode = 1;
});
