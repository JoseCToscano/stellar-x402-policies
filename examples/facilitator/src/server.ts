/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal x402 facilitator. POST /verify and POST /settle use the same JSON
 * body as `@x402/core`'s HTTP facilitator client.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { PolicyAwareExactStellarScheme, readPolicyAwareOptions } from "stellar-x402-policies";

import { loadLocalEnv, readNetwork, requireEnv } from "./dotenv.js";

const MAX_BODY_BYTES = 1_000_000;

interface FacilitatorRequest {
  paymentPayload?: PaymentPayload;
  paymentRequirements?: PaymentRequirements;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds 1 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<FacilitatorRequest> {
  const text = await readBody(req);
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as FacilitatorRequest;
}

function requirePayment(body: FacilitatorRequest): {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
} {
  if (body.paymentPayload === undefined || body.paymentRequirements === undefined) {
    throw new Error("Request body must include paymentPayload and paymentRequirements");
  }
  return {
    paymentPayload: body.paymentPayload,
    paymentRequirements: body.paymentRequirements,
  };
}

export function createFacilitator(): x402Facilitator {
  const network = readNetwork();
  const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET_KEY"), network);
  const options = readPolicyAwareOptions(process.env);
  const scheme = new PolicyAwareExactStellarScheme([signer], options);
  console.log(
    JSON.stringify({
      network,
      facilitator: signer.address,
      feeProfile: scheme.feeProfile.name,
      maxTransactionFeeStroops: scheme.maxTransactionFeeStroops,
      policyContracts: scheme.policyContracts.length,
      policyEventTopics: scheme.policyEventTopics,
      customRpc: options.rpcConfig !== undefined,
    }),
  );
  return new x402Facilitator().register(network, scheme);
}

export function startServer(facilitator: x402Facilitator): void {
  const port = Number(process.env.PORT ?? "4020");
  const host = process.env.HOST?.trim() || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  const server = createServer((req, res) => {
    void handle(facilitator, req, res);
  });
  server.listen(port, host, () => {
    console.log(`facilitator listening on http://${host}:${port}`);
  });
}

async function handle(
  facilitator: x402Facilitator,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && path === "/supported") {
      sendJson(res, 200, facilitator.getSupported());
      return;
    }
    if (req.method === "POST" && (path === "/verify" || path === "/settle")) {
      const body = requirePayment(await readJson(req));
      const result =
        path === "/verify"
          ? await facilitator.verify(body.paymentPayload, body.paymentRequirements)
          : await facilitator.settle(body.paymentPayload, body.paymentRequirements);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    sendJson(res, 400, { error: message });
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  loadLocalEnv();
  startServer(createFacilitator());
}
