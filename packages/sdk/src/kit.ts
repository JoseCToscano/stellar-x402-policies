/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { signAuthEntry } from "./auth.js";
import { estimateFeeFromSimulation } from "./fee.js";
import { parseContextRule, readI128, readU32 } from "./parse.js";
import { precheckFromReport, reasonFromSimulationError } from "./precheck.js";
import { stellarRpc, type KitRpc, type SimulatedCall } from "./rpc.js";
import type { AgentSigner } from "./signers.js";
import { compileTemplate, type CompiledTemplate, type TemplateDocument } from "./templates.js";
import {
  PayRefused,
  type AccountReport,
  type ExactRequirements,
  type FeeEstimate,
  type MerchantRemaining,
  type PayReceipt,
  type PrecheckResult,
} from "./types.js";

const BASE_FEE = "100";
const HISTORY_CAPACITY = 815;

export interface SpendingPolicyKitOptions {
  rpcUrl: string;
  networkPassphrase: string;
  facilitatorUrl?: string;
  /** G account that fronts the unsigned payment. The facilitator pays the fee. */
  sourceAccount?: string;
  /** Ed25519 verifier contract the agent signs with. */
  verifier?: string;
  /** Agent G address, used as the external signer public key. */
  agentAccount?: string;
  /** Merchants to query with `get_remaining` during inspect. */
  merchants?: readonly string[];
  /** Policy contract whose `get_remaining(account, rule, merchant)` is simulated. */
  merchantAllowlist?: string;
  rpc?: KitRpc;
  fetch?: typeof fetch;
}

export interface PayOptions {
  signer: AgentSigner;
  maxAmount?: bigint;
  account?: string;
  sourceAccount?: string;
  contextRuleId?: number;
  publicKey?: Buffer;
}

export class SpendingPolicyKit {
  readonly networkPassphrase: string;
  readonly facilitatorUrl: string | undefined;
  readonly templates = { compile: this.compileTemplate.bind(this) };
  private readonly rpc: KitRpc;
  private readonly fetchImpl: typeof fetch;
  private readonly options: SpendingPolicyKitOptions;

  constructor(options: SpendingPolicyKitOptions) {
    this.options = options;
    this.networkPassphrase = options.networkPassphrase;
    this.facilitatorUrl = options.facilitatorUrl;
    this.rpc = options.rpc ?? stellarRpc(options.rpcUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async inspect(account: string, merchants: readonly string[] = this.options.merchants ?? []): Promise<AccountReport> {
    const latest = await this.rpc.getLatestLedger();
    const count = readU32(await this.call(account, "get_context_rules_count", []));
    const rules = [];
    for (let id = 0; id < count; id += 1) {
      const retval = await this.call(account, "get_context_rule", [xdr.ScVal.scvU32(id)]);
      rules.push(parseContextRule(retval));
    }
    const merchantRows: MerchantRemaining[] = [];
    const policy = this.options.merchantAllowlist;
    if (policy !== undefined) {
      for (const rule of rules) {
        if (rule.type !== "CallContract") {
          continue;
        }
        for (const merchant of merchants) {
          const simulated = await this.simulateCall(policy, "get_remaining", [
            new Address(account).toScVal(),
            xdr.ScVal.scvU32(rule.id),
            new Address(merchant).toScVal(),
          ]);
          if (simulated.error !== undefined) {
            const reason = reasonFromSimulationError(simulated.error);
            merchantRows.push({
              merchant,
              remaining: 0n,
              allowed: reason !== "merchant_not_allowed",
            });
            continue;
          }
          if (simulated.retval === undefined) {
            continue;
          }
          merchantRows.push({
            merchant,
            remaining: readI128(simulated.retval),
            allowed: true,
          });
        }
      }
    }
    return {
      address: account,
      ledger: latest.sequence,
      rules,
      merchants: merchantRows,
    };
  }

  async estimateFee(requirements: ExactRequirements, account: string): Promise<FeeEstimate> {
    const source = this.requireSource();
    const simulated = await this.simulateTransfer(requirements, account, source);
    if (simulated.error !== undefined) {
      throw new Error(`fee simulation failed: ${simulated.error}`);
    }
    return estimateFeeFromSimulation({
      minResourceFee: simulated.minResourceFee,
      ...(simulated.rentStroops !== undefined ? { rentStroops: simulated.rentStroops } : {}),
    });
  }

  async precheck(requirements: ExactRequirements, account: string): Promise<PrecheckResult> {
    const report = await this.inspect(account);
    const local = precheckFromReport(report, requirements, report.ledger);
    if (local !== undefined) {
      return local;
    }
    const source = this.requireSource();
    const simulated = await this.simulateTransfer(requirements, account, source);
    if (simulated.error !== undefined) {
      const reason = reasonFromSimulationError(simulated.error);
      if (reason !== undefined) {
        return { ok: false, reason, needsOwnerApproval: true };
      }
      throw new Error(`precheck simulation failed: ${simulated.error}`);
    }
    if (report.historyFill !== undefined && report.historyFill.entries >= HISTORY_CAPACITY) {
      return { ok: false, reason: "history_full", needsOwnerApproval: true };
    }
    return { ok: true };
  }

  /**
   * Signs the smart-account auth entry and asks the facilitator to settle.
   * A failed precheck is returned locally and does not call the facilitator.
   */
  async pay(input: string | ExactRequirements, options: PayOptions): Promise<PayReceipt> {
    const requirements = typeof input === "string" ? await this.requirementsFromUrl(input) : input;
    if (options.maxAmount !== undefined && BigInt(requirements.amount) > options.maxAmount) {
      throw new PayRefused("over_per_tx");
    }
    const account = options.account ?? this.options.agentAccount;
    if (account === undefined || !account.startsWith("C")) {
      throw new Error("pay requires the smart account C address");
    }
    const decision = await this.precheck(requirements, account);
    if (!decision.ok) {
      throw new PayRefused(decision.reason);
    }
    if (this.facilitatorUrl === undefined) {
      throw new Error("facilitatorUrl is required to pay");
    }
    const source = options.sourceAccount ?? this.requireSource();
    const recorded = await this.simulateTransfer(requirements, account, source);
    const entry = recorded.auth?.[0];
    if (entry === undefined) {
      throw new Error("payment simulation did not return an auth entry");
    }
    const verifier = this.options.verifier;
    const agent = this.options.agentAccount;
    if (verifier === undefined) {
      throw new Error("verifier is required to sign");
    }
    const publicKey =
      options.publicKey ??
      (agent !== undefined && agent.startsWith("G")
        ? Buffer.from(Keypair.fromPublicKey(agent).rawPublicKey())
        : undefined);
    if (publicKey === undefined) {
      throw new Error("agentAccount or publicKey is required to sign");
    }
    const latest = await this.rpc.getLatestLedger();
    const rule = (await this.inspect(account)).rules.find(
      (item) => item.type === "CallContract" && item.contract === requirements.asset,
    );
    const signed = await signAuthEntry(entry, {
      networkPassphrase: this.networkPassphrase,
      expirationLedger: latest.sequence + 20,
      contextRuleId: options.contextRuleId ?? rule?.id ?? 1,
      verifier,
      publicKey,
      signer: options.signer,
      smartAccount: account,
    });
    const funded = await this.account(source);
    const signedTx = this.transferTx(
      requirements,
      account,
      funded.accountId(),
      funded.sequenceNumber(),
      [signed],
    );
    const enforced = await this.rpc.simulate(signedTx);
    if (enforced.error !== undefined) {
      const reason = reasonFromSimulationError(enforced.error);
      if (reason !== undefined) {
        throw new PayRefused(reason);
      }
      throw new Error(`payment simulation failed: ${enforced.error}`);
    }
    const transaction = signedTx.toXDR();
    const body = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      },
      paymentRequirements: requirements,
    };
    const settled = await this.postJson("/settle", body);
    const txHash = typeof settled.transaction === "string" ? settled.transaction : "";
    if (settled.success !== true || txHash.length === 0) {
      throw new Error(`settle failed: ${settled.errorReason ?? "unknown"}`);
    }
    let feeCharged = typeof settled.feeCharged === "number" ? settled.feeCharged : 0;
    if (feeCharged === 0 && this.rpc.getTransaction !== undefined) {
      feeCharged = (await this.rpc.getTransaction(txHash)).feeCharged;
    }
    return { txHash, feeCharged };
  }

  compileTemplate(
    template: TemplateDocument,
    params: Record<string, string | number>,
  ): CompiledTemplate {
    return compileTemplate(template, params);
  }

  private requireSource(): string {
    const source = this.options.sourceAccount;
    if (source === undefined) {
      throw new Error("sourceAccount is required");
    }
    return source;
  }

  private async requirementsFromUrl(url: string): Promise<ExactRequirements> {
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (response.status !== 402) {
      throw new Error(`${url} returned ${response.status}, expected 402`);
    }
    const body = (await response.json()) as { accepts?: ExactRequirements[] };
    const requirements = body.accepts?.[0];
    if (requirements === undefined) {
      throw new Error(`${url} did not include payment requirements`);
    }
    return requirements;
  }

  private async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}`);
    }
    return parsed;
  }

  private async call(contract: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const simulated = await this.simulateCall(contract, method, args);
    if (simulated.error !== undefined || simulated.retval === undefined) {
      throw new Error(simulated.error ?? `${method} returned no value`);
    }
    return simulated.retval;
  }

  private async simulateCall(
    contract: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SimulatedCall> {
    const source = this.options.sourceAccount ?? Keypair.random().publicKey();
    const account = await this.account(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build();
    return this.rpc.simulate(tx);
  }

  private async simulateTransfer(
    requirements: ExactRequirements,
    account: string,
    source: string,
  ): Promise<SimulatedCall> {
    const funded = await this.account(source);
    return this.rpc.simulate(
      this.transferTx(requirements, account, funded.accountId(), funded.sequenceNumber(), []),
    );
  }

  private transferTx(
    requirements: ExactRequirements,
    payer: string,
    source: string,
    sequence: string,
    auth: xdr.SorobanAuthorizationEntry[],
  ): Transaction {
    const amount = BigInt(requirements.amount);
    const call = new Contract(requirements.asset).call(
      "transfer",
      new Address(payer).toScVal(),
      new Address(requirements.payTo).toScVal(),
      i128(amount),
    );
    const operation = auth.length === 0 ? call : invokeWithAuth(call, auth);
    return new TransactionBuilder(new Account(source, sequence), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(requirements.maxTimeoutSeconds ?? 300)
      .build();
  }

  private async account(source: string): Promise<Account> {
    const loaded = await this.rpc.getAccount(source);
    return new Account(source, loaded.sequence);
  }
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

function invokeWithAuth(
  operation: xdr.Operation,
  auth: xdr.SorobanAuthorizationEntry[],
): xdr.Operation {
  const body = operation.body();
  if (body.switch().name !== "invokeHostFunction") {
    throw new Error("expected invokeHostFunction");
  }
  const host = body.invokeHostFunctionOp();
  return xdr.Operation.fromXDR(
    new xdr.Operation({
      sourceAccount: operation.sourceAccount(),
      body: xdr.OperationBody.invokeHostFunction(
        new xdr.InvokeHostFunctionOp({
          hostFunction: host.hostFunction(),
          auth,
        }),
      ),
    }).toXDR(),
  );
}
