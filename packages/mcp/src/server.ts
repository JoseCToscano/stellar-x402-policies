/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PayRefused,
  type AgentSigner,
  type ExactRequirements,
  type FeeEstimate,
  type PayReceipt,
  type SpendingPolicyKit,
} from "@stellar-x402-policies/sdk";
import { z } from "zod";

import { errorMessage } from "./redact.js";

const requirementsSchema = z.object({
  scheme: z.string().optional(),
  network: z.string().optional(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function text(summary: string, payload: unknown) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n${stringify(payload)}` }],
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: stringify({ status: "error", message }) }],
  };
}

async function loadRequirements(
  fetchImpl: typeof fetch,
  input: { url?: string; requirements?: ExactRequirements },
): Promise<ExactRequirements> {
  if (input.requirements !== undefined) {
    return input.requirements;
  }
  if (input.url === undefined) {
    throw new Error("url or requirements is required");
  }
  const response = await fetchImpl(input.url, { headers: { accept: "application/json" } });
  if (response.status !== 402) {
    throw new Error(`resource returned ${response.status}`);
  }
  const body = (await response.json()) as { accepts?: ExactRequirements[] };
  const requirements = body.accepts?.[0];
  if (requirements === undefined) {
    throw new Error("resource did not include payment requirements");
  }
  return requirements;
}

function summarizeReport(report: { address: string; ledger: number; rules: { name: string; type: string; validUntil?: number }[]; merchants: unknown[] }): string {
  const rules = report.rules
    .map((rule) => {
      const until = rule.validUntil === undefined ? "no expiry" : `until ledger ${rule.validUntil}`;
      return `${rule.name} (${rule.type}, ${until})`;
    })
    .join("; ");
  return `Account ${report.address} at ledger ${report.ledger}: ${rules || "no rules"}. ${report.merchants.length} merchant allowance row(s).`;
}

function summarizeFee(estimate: FeeEstimate): string {
  return `${estimate.class} simulation ${estimate.simulatedStroops} stroops, recommended ceiling ${estimate.recommendedCeiling}.`;
}

function summarizeReceipt(receipt: PayReceipt): string {
  return `Settled ${receipt.txHash} for ${receipt.feeCharged} stroops.`;
}

export interface McpRuntime {
  kit: SpendingPolicyKit;
  signer: AgentSigner;
  account: string;
  fetchImpl?: typeof fetch;
}

/** Builds the stdio tool surface. Tool handlers catch errors and never return stack traces. */
export function createMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({ name: "stellar-x402-policies", version: "0.1.0" });
  const fetchImpl = runtime.fetchImpl ?? fetch;

  server.registerTool(
    "inspect_account",
    {
      description: "Read smart-account rules, signers, policies, and remaining allowances.",
      inputSchema: {
        address: z.string().describe("Smart account C or W address"),
      },
    },
    async ({ address }) => {
      try {
        const report = await runtime.kit.inspect(address);
        return text(summarizeReport(report), report);
      } catch (error) {
        return failure(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "estimate_fee",
    {
      description: "Classify a payment simulation as warm or cold and recommend a facilitator fee ceiling.",
      inputSchema: {
        address: z.string().describe("Smart account C or W address"),
        url: z.string().optional().describe("x402 resource URL that returns HTTP 402"),
        requirements: requirementsSchema.optional(),
      },
    },
    async (input) => {
      try {
        const requirements = await loadRequirements(fetchImpl, input);
        const estimate = await runtime.kit.estimateFee(requirements, input.address);
        return text(summarizeFee(estimate), estimate);
      } catch (error) {
        return failure(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "pay",
    {
      description:
        "Pay an x402 resource with the agent key. Over-cap and non-allowlisted merchants return needs_owner_approval.",
      inputSchema: {
        url: z.string().optional().describe("x402 resource URL"),
        requirements: requirementsSchema.optional(),
        max_amount: z.string().optional().describe("Maximum stroops the agent may spend"),
      },
    },
    async (input) => {
      try {
        const requirements =
          input.url !== undefined && input.requirements === undefined
            ? input.url
            : await loadRequirements(fetchImpl, input);
        const receipt = await runtime.kit.pay(requirements, {
          signer: runtime.signer,
          account: runtime.account,
          ...(input.max_amount !== undefined ? { maxAmount: BigInt(input.max_amount) } : {}),
        });
        return text(summarizeReceipt(receipt), receipt);
      } catch (error) {
        if (error instanceof PayRefused) {
          return text(`Payment needs owner approval: ${error.reason}.`, {
            status: "needs_owner_approval",
            reason: error.reason,
          });
        }
        return failure(errorMessage(error));
      }
    },
  );

  return server;
}
