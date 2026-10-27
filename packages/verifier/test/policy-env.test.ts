/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { readPolicyAwareOptions } from "../src/env.js";

describe("readPolicyAwareOptions", () => {
  it("merges X402_POLICY_EVENT_CONTRACTS with POLICY_CONTRACT_IDS", () => {
    const options = readPolicyAwareOptions({
      POLICY_CONTRACT_IDS: "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6",
      X402_POLICY_EVENT_CONTRACTS:
        "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6,CB2VQO2NYP4DJBPNCZGRGEUKIUCK7BJW66OXEPDHV7RJT2ICW23X3EL5",
    });
    expect(options.policyContracts).toEqual([
      "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6",
      "CB2VQO2NYP4DJBPNCZGRGEUKIUCK7BJW66OXEPDHV7RJT2ICW23X3EL5",
    ]);
  });
});
