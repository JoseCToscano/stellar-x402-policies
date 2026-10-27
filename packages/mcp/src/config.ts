/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  network: "testnet" | "mainnet";
  account: string;
  /** Agent seed. Callers must not log this value. */
  agentSecret: string;
  rpcUrl: string;
  facilitatorUrl: string;
  verifier: string;
  sourceAccount?: string;
  merchantAllowlist?: string;
  /** Test double. `ok` settles; `over_cap` simulates error #3402. */
  mock?: "ok" | "over_cap";
}

const DEFAULT_VERIFIER = "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

/**
 * Reads MCP configuration. Refuses mainnet unless SXP_ALLOW_MAINNET=1.
 * Error text never includes secret values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const network = (env.SXP_NETWORK ?? "").trim().toLowerCase();
  if (network === "mainnet" && env.SXP_ALLOW_MAINNET !== "1") {
    throw new ConfigError("refusing to start: SXP_NETWORK=mainnet requires SXP_ALLOW_MAINNET=1");
  }
  if (network !== "testnet" && network !== "mainnet") {
    throw new ConfigError("SXP_NETWORK must be testnet or mainnet");
  }
  const account = required(env, "SXP_ACCOUNT");
  if (!account.startsWith("C") && !account.startsWith("W")) {
    throw new ConfigError("SXP_ACCOUNT must be the smart-account address");
  }
  const agentSecret = required(env, "SXP_AGENT_SECRET");
  if (!agentSecret.startsWith("S")) {
    throw new ConfigError("SXP_AGENT_SECRET must be the agent key");
  }
  const mockRaw = env.SXP_MOCK?.trim();
  let mock: ServerConfig["mock"];
  if (mockRaw === "ok" || mockRaw === "over_cap") {
    mock = mockRaw;
  } else if (mockRaw !== undefined && mockRaw.length > 0) {
    throw new ConfigError("SXP_MOCK must be ok or over_cap");
  }
  const source = env.SXP_SOURCE?.trim();
  const merchant = env.SXP_MERCHANT_ALLOWLIST?.trim();
  const verifier = env.SXP_VERIFIER?.trim();
  return {
    network,
    account,
    agentSecret,
    rpcUrl: required(env, "SXP_RPC_URL"),
    facilitatorUrl: required(env, "SXP_FACILITATOR_URL").replace(/\/$/, ""),
    verifier: verifier !== undefined && verifier.length > 0 ? verifier : DEFAULT_VERIFIER,
    ...(source !== undefined && source.length > 0 ? { sourceAccount: source } : {}),
    ...(merchant !== undefined && merchant.length > 0 ? { merchantAllowlist: merchant } : {}),
    ...(mock !== undefined ? { mock } : {}),
  };
}
