/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Upload and deploy the M1 policy contracts on Stellar testnet.
 * The deployer key is generated here, funded with Friendbot, and discarded.
 * The script prints public contract ids, wasm hashes, and fees. It does not
 * print the seed.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../packages/verifier/package.json", import.meta.url),
);
const {
  Address,
  BASE_FEE,
  hash,
  Keypair,
  Networks,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} = require("@stellar/stellar-sdk");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const FRIENDBOT = "https://friendbot.stellar.org";

function redact(text) {
  return text.replace(/\bS[A-Z2-7]{55}\b/g, "[redacted-secret]");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expert(txHash) {
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
}

function contractId(deployer, salt) {
  const networkId = hash(Buffer.from(PASSPHRASE));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

async function friendbot(publicKey) {
  const url = `${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`;
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return;
    }
    last = `${response.status}`;
    await sleep(1000 * attempt);
  }
  throw new Error(`friendbot failed: ${last}`);
}

async function waitForAccount(server, publicKey) {
  let last = "not found";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      return await server.getAccount(publicKey);
    } catch (error) {
      last = error instanceof Error ? error.message : "account lookup failed";
      await sleep(1000);
    }
  }
  throw new Error(`RPC did not see ${publicKey}: ${redact(last)}`);
}

async function submit(server, source, operation, label) {
  let last = "not submitted";
  for (let build = 1; build <= 4; build += 1) {
    const account = await waitForAccount(server, source.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(source);
    let sent;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      sent = await server.sendTransaction(prepared);
      if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
        break;
      }
      if (sent.status === "TRY_AGAIN_LATER" && attempt < 5) {
        await sleep(1000 * attempt);
        continue;
      }
      const code = sent.errorResult?.result().switch().name ?? sent.status;
      last = code;
      if (code === "txBadSeq" && build < 4) {
        await sleep(1500 * build);
        sent = undefined;
        break;
      }
      throw new Error(`${label} was not accepted: ${code}`);
    }
    if (sent === undefined || (sent.status !== "PENDING" && sent.status !== "DUPLICATE")) {
      continue;
    }
    const polled = await server.pollTransaction(sent.hash, { attempts: 40 });
    if (polled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`${label} ${polled.status} ${sent.hash} ${expert(sent.hash)}`);
    }
    await sleep(1000);
    return {
      hash: sent.hash,
      feeCharged: Number(polled.resultXdr.feeCharged()),
      ledger: polled.ledger,
      url: expert(sent.hash),
    };
  }
  throw new Error(`${label} was not accepted: ${last}`);
}

async function deployOne(server, source, wasmPath) {
  const wasm = readFileSync(wasmPath);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  const upload = await submit(
    server,
    source,
    Operation.uploadContractWasm({ wasm }),
    `upload ${wasmPath}`,
  );
  const salt = randomBytes(32);
  const id = contractId(source.publicKey(), salt);
  const deploy = await submit(
    server,
    source,
    Operation.createCustomContract({
      address: Address.fromString(source.publicKey()),
      wasmHash: Buffer.from(wasmHash, "hex"),
      salt,
    }),
    `deploy ${wasmPath}`,
  );
  return {
    contractId: id,
    wasmHash,
    wasmBytes: wasm.length,
    upload,
    deploy,
  };
}

const server = new rpc.Server(RPC_URL);
const source = Keypair.random();
await friendbot(source.publicKey());
await sleep(2000);

const wasmDir = join(ROOT, "contracts/target/wasm32v1-none/release");
console.log(JSON.stringify({ step: "funded", deployer: source.publicKey() }));
const merchant = await deployOne(
  server,
  source,
  join(wasmDir, "merchant_allowlist_policy.wasm"),
);
console.log(JSON.stringify({ step: "merchant", ...merchant }));
const period = await deployOne(server, source, join(wasmDir, "period_cap_policy.wasm"));
console.log(JSON.stringify({ step: "period", ...period }));

const document = {
  network: "testnet",
  networkPassphrase: PASSPHRASE,
  rpcUrl: RPC_URL,
  stellarAccounts: "0.8.0",
  sorobanSdk: "28.0.0",
  deployedAt: new Date().toISOString(),
  deployer: source.publicKey(),
  contracts: {
    merchantAllowlist: merchant,
    periodCap: period,
  },
};

const out = join(ROOT, "deployments/testnet.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify(document, null, 2));
