/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

import type { SimulationEventView } from "./classify.js";

/**
 * Converts one Soroban diagnostic event into the view the classifier uses.
 * Throws when the contract-event body cannot be decoded.
 */
export function parseDiagnosticEvent(diagnostic: xdr.DiagnosticEvent): SimulationEventView {
  const event = diagnostic.event();
  const type = event.type().name;
  const rawContractId = event.contractId();
  const contractId = rawContractId
    ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(rawContractId)).toString()
    : null;

  if (type !== "contract") {
    return { type, contractId, topics: [], data: null };
  }

  const body = event.body().v0();
  return {
    type,
    contractId,
    topics: body.topics().map((topic) => scValToNative(topic)),
    data: scValToNative(body.data()),
  };
}
