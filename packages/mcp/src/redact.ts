/**
 * Copyright 2026 Jose Carlos Toscano
 * SPDX-License-Identifier: Apache-2.0
 */

const STELLAR_SECRET = /S[A-Z2-7]{55}/g;

/** Removes Stellar seeds and any extra secret strings from text that may be logged. */
export function redact(text: string, extras: readonly string[] = []): string {
  let out = text.replace(STELLAR_SECRET, "[redacted]");
  for (const extra of extras) {
    if (extra.length > 0) {
      out = out.split(extra).join("[redacted]");
    }
  }
  return out;
}

export function errorMessage(error: unknown, extras: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : "request failed";
  return redact(raw, extras);
}
