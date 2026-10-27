#!/usr/bin/env node
/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Ed25519Signer, SpendingPolicyKit } from "@stellar-x402-policies/sdk";

import { loadConfig } from "./config.js";
import { mockRpc } from "./mock-rpc.js";
import { redact } from "./redact.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(config.agentSecret);
  } catch {
    throw new Error("SXP_AGENT_SECRET must be the agent key");
  }
  const kit = new SpendingPolicyKit({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    facilitatorUrl: config.facilitatorUrl,
    sourceAccount: config.sourceAccount ?? keypair.publicKey(),
    verifier: config.verifier,
    agentAccount: keypair.publicKey(),
    ...(config.merchantAllowlist !== undefined ? { merchantAllowlist: config.merchantAllowlist } : {}),
    ...(config.mock !== undefined ? { rpc: mockRpc(config.mock, config.account) } : {}),
  });
  const server = createMcpServer({
    kit,
    signer: new Ed25519Signer(keypair),
    account: config.account,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write("sxp-mcp ready\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
});
