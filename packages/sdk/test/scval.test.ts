/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { sortedMap } from "../src/scval.js";

describe("sortedMap", () => {
  it("orders symbols by content so shorter keys do not jump ahead", () => {
    const map = sortedMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: xdr.ScVal.scvVoid() }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVoid(),
      }),
    ]);
    expect(map.map()?.[0]?.key().sym().toString()).toBe("context_rule_ids");
  });
});
