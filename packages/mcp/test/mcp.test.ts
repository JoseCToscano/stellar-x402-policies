/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MOCK_ASSET } from "../src/mock-rpc.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(ROOT, "..");
const ACCOUNT = "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6";
const MERCHANT = "GCV3S4NA5Q3EZ5UZPUZMDLQWOP6FU52TEOCUNAZWYIKMFHHDWCH4LD4U";

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

class StdioSession {
  readonly stdoutChunks: string[] = [];
  readonly stderrChunks: string[] = [];
  private buffer = "";
  private nextId = 0;
  private readonly waiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  readonly exited: Promise<number | null>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutChunks.push(chunk);
      this.buffer += chunk;
      this.drain();
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
    this.exited = new Promise((resolve) => {
      child.once("close", (status) => resolve(status));
    });
  }

  get stdout(): string {
    return this.stdoutChunks.join("");
  }

  get stderr(): string {
    return this.stderrChunks.join("");
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const pending = new Promise<unknown>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return timeout(pending, `${method} timed out`);
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill();
    await once(this.child, "exit").catch(() => undefined);
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
      const message = JSON.parse(line) as RpcMessage;
      if (typeof message.id !== "number") {
        continue;
      }
      const waiter = this.waiters.get(message.id);
      if (waiter === undefined) {
        continue;
      }
      this.waiters.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? "rpc error"));
      } else {
        waiter.resolve(message.result);
      }
    }
  }
}

function timeout(promise: Promise<unknown>, message: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 8_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}

function spawnServer(env: Record<string, string>): StdioSession {
  const child = spawn(process.execPath, ["dist/stdio.js"], {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new StdioSession(child);
}

async function connect(session: StdioSession): Promise<void> {
  await session.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "sxp-test", version: "0.0.0" },
  });
  session.notify("notifications/initialized");
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}

function payloadOf(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("tool result did not include JSON");
  }
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

function assertSecretAbsent(secret: string, stdout: string, stderr: string): void {
  expect(stdout.includes(secret), "stdout contains the agent secret").toBe(false);
  expect(stderr.includes(secret), "stderr contains the agent secret").toBe(false);
}

function baseEnv(secret: string, extra: Record<string, string>): Record<string, string> {
  return {
    SXP_ACCOUNT: ACCOUNT,
    SXP_AGENT_SECRET: secret,
    SXP_RPC_URL: "https://soroban-testnet.stellar.org",
    SXP_FACILITATOR_URL: "http://127.0.0.1:9",
    SXP_NETWORK: "testnet",
    ...extra,
  };
}

function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          transaction: "ab".repeat(32),
          feeCharged: 48_067,
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("facilitator mock failed to bind");
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("loadConfig", () => {
  it("refuses mainnet unless SXP_ALLOW_MAINNET=1", () => {
    const env = {
      SXP_NETWORK: "mainnet",
      SXP_ACCOUNT: ACCOUNT,
      SXP_AGENT_SECRET: "S".padEnd(56, "A"),
      SXP_RPC_URL: "https://example.invalid",
      SXP_FACILITATOR_URL: "http://127.0.0.1:9",
    };
    expect(() => loadConfig(env)).toThrow(/SXP_ALLOW_MAINNET/);
    expect(loadConfig({ ...env, SXP_ALLOW_MAINNET: "1" }).network).toBe("mainnet");
  });
});

describe("mcp stdio", () => {
  it("lists the tools and calls each one against the mock RPC", async () => {
    const secret = Keypair.random().secret();
    const facilitator = await listen();
    const session = spawnServer(
      baseEnv(secret, { SXP_MOCK: "ok", SXP_FACILITATOR_URL: facilitator.url }),
    );
    try {
      await connect(session);
      const listed = (await session.request("tools/list", {})) as { tools: Array<{ name: string }> };
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["estimate_fee", "inspect_account", "pay"]);

      const inspected = payloadOf(
        toolText(await session.request("tools/call", { name: "inspect_account", arguments: { address: ACCOUNT } })),
      );
      expect(inspected.address).toBe(ACCOUNT);
      expect(inspected.rules).toHaveLength(1);

      const fee = payloadOf(
        toolText(
          await session.request("tools/call", {
            name: "estimate_fee",
            arguments: {
              address: ACCOUNT,
              requirements: {
                asset: MOCK_ASSET,
                amount: "1000000",
                payTo: MERCHANT,
              },
            },
          }),
        ),
      );
      expect(fee.class).toBe("warm");
      expect(fee.simulatedStroops).toBe(58_328);
      expect(fee.recommendedCeiling).toBe(500_000);

      const paid = payloadOf(
        toolText(
          await session.request("tools/call", {
            name: "pay",
            arguments: {
              max_amount: "2000000",
              requirements: {
                asset: MOCK_ASSET,
                amount: "1000000",
                payTo: MERCHANT,
                network: "stellar:testnet",
                scheme: "exact",
              },
            },
          }),
        ),
      );
      expect(paid.txHash).toBe("ab".repeat(32));
      expect(paid.feeCharged).toBe(48_067);
      assertSecretAbsent(secret, session.stdout, session.stderr);
    } finally {
      await session.close();
      facilitator.server.close();
    }
  });

  it("returns needs_owner_approval when pay is over the cap", async () => {
    const secret = Keypair.random().secret();
    const session = spawnServer(baseEnv(secret, { SXP_MOCK: "over_cap" }));
    try {
      await connect(session);
      const paid = payloadOf(
        toolText(
          await session.request("tools/call", {
            name: "pay",
            arguments: {
              max_amount: "5000000",
              requirements: {
                asset: MOCK_ASSET,
                amount: "1000000",
                payTo: MERCHANT,
              },
            },
          }),
        ),
      );
      expect(paid).toEqual({ status: "needs_owner_approval", reason: "over_cap" });
      assertSecretAbsent(secret, session.stdout, session.stderr);
    } finally {
      await session.close();
    }
  });

  it("exits on mainnet without printing the agent secret", async () => {
    const secret = Keypair.random().secret();
    const session = spawnServer(baseEnv(secret, { SXP_NETWORK: "mainnet" }));
    const code = await session.exited;
    expect(code).not.toBe(0);
    expect(session.stderr).toMatch(/SXP_ALLOW_MAINNET/);
    assertSecretAbsent(secret, session.stdout, session.stderr);
  });
});
