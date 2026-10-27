/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StrKey } from "@stellar/stellar-sdk";
import { encodeMuxedContract } from "stellar-x402-policies";
import { describe, expect, it } from "vitest";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, "..", "dist", "cli.js");
const FIXTURE = join(ROOT, "fixtures", "account.json");
const PARAMS = join(ROOT, "fixtures", "params.json");
const ACCOUNT = "CA37FAB2OXRQLTMKR36QXMT3JREOVIEDDK7SW3YCAB6NRZZNZUG7K7BV";

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("sxp", () => {
  it("prints inspect --json for a fixture", async () => {
    const result = await run(["inspect", ACCOUNT, "--json", "--fixture", FIXTURE]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchSnapshot();
  });

  it("prints a W address as its base contract", async () => {
    const muxed = encodeMuxedContract(StrKey.decodeContract(ACCOUNT), 7n);
    const result = await run(["inspect", muxed, "--json", "--fixture", FIXTURE]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { address: string; baseAddress: string; muxId: string };
    expect(parsed.address).toBe(muxed);
    expect(parsed.baseAddress).toBe(ACCOUNT);
    expect(parsed.muxId).toBe("7");
    expect(result.stdout).toMatchSnapshot();
  });

  it("prints dry-run install XDR for each template", async () => {
    for (const name of ["agent-daily-usdc", "agent-merchant-allowlist", "agent-monthly-multi-asset"]) {
      const result = await run([
        "templates",
        "apply",
        name,
        "--account",
        ACCOUNT,
        "--params",
        PARAMS,
        "--dry-run",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("installXdr:");
      expect(result.stdout).toContain("ownerRule: Default");
      expect(result.stdout).toMatchSnapshot();
    }
  });

  it("exports the verifier event allowlist", async () => {
    const result = await run(["allowlist", "export"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "X402_POLICY_EVENT_CONTRACTS=CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6,CB2VQO2NYP4DJBPNCZGRGEUKIUCK7BJW66OXEPDHV7RJT2ICW23X3EL5,CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5\n",
    );
  });

  it("exits non-zero on invalid input", async () => {
    const missing = await run([]);
    const bare = await run(["inspect"]);
    const apply = await run(["templates", "apply"]);
    expect(missing.code).not.toBe(0);
    expect(bare.code).not.toBe(0);
    expect(apply.code).not.toBe(0);
  });
});
