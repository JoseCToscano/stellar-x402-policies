/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads KEY=VALUE pairs from the nearest dotenv file at or above the working
 * directory. `pnpm --filter` runs an example with that package as cwd, so a
 * repo-root `.env` is still found. Existing environment variables win.
 * Values are never logged.
 */
export function loadLocalEnv(fileName = ".env"): void {
  const path = findEnvFile(fileName);
  if (path === undefined) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = stripped.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = stripped.slice(0, separator).trim();
    let value = stripped.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function findEnvFile(fileName: string): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment or in a gitignored .env file. See .env.example.`,
    );
  }
  return value;
}

export function readNetwork(): "stellar:testnet" | "stellar:pubnet" {
  const network = process.env.STELLAR_NETWORK?.trim() || "stellar:testnet";
  if (network !== "stellar:testnet" && network !== "stellar:pubnet") {
    throw new Error('STELLAR_NETWORK must be "stellar:testnet" or "stellar:pubnet"');
  }
  if (network === "stellar:pubnet" && !process.env.STELLAR_RPC_URL?.trim()) {
    throw new Error("STELLAR_RPC_URL is required for stellar:pubnet");
  }
  return network;
}
