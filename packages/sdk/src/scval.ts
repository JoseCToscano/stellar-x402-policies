/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host ScVal ordering. XDR length prefixes are not the host order for
 * symbols, strings, bytes, or vectors. A map the host rejects as unsorted
 * fails with Error(Object, InvalidInput).
 */

import { xdr } from "@stellar/stellar-sdk";

export function compareScVal(left: xdr.ScVal, right: xdr.ScVal): number {
  const leftType = left.switch().value;
  const rightType = right.switch().value;
  if (leftType !== rightType) {
    return leftType < rightType ? -1 : 1;
  }
  switch (left.switch().name) {
    case "scvVec": {
      const leftItems = left.vec() ?? [];
      const rightItems = right.vec() ?? [];
      const length = Math.min(leftItems.length, rightItems.length);
      for (let index = 0; index < length; index += 1) {
        const leftItem = leftItems[index];
        const rightItem = rightItems[index];
        if (leftItem === undefined || rightItem === undefined) {
          break;
        }
        const compared = compareScVal(leftItem, rightItem);
        if (compared !== 0) {
          return compared;
        }
      }
      return leftItems.length - rightItems.length;
    }
    case "scvSymbol":
      return Buffer.compare(Buffer.from(left.sym().toString(), "utf8"), Buffer.from(right.sym().toString(), "utf8"));
    case "scvString":
      return Buffer.compare(Buffer.from(left.str().toString(), "utf8"), Buffer.from(right.str().toString(), "utf8"));
    case "scvBytes":
      return Buffer.compare(Buffer.from(left.bytes()), Buffer.from(right.bytes()));
    case "scvAddress":
      return Buffer.compare(left.address().toXDR(), right.address().toXDR());
    default:
      return Buffer.compare(left.toXDR(), right.toXDR());
  }
}

export function sortedMap(entries: readonly xdr.ScMapEntry[]): xdr.ScVal {
  const sorted = [...entries].sort((left, right) => compareScVal(left.key(), right.key()));
  return xdr.ScVal.scvMap(sorted);
}
