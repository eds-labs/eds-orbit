// Redaction of text that leaves Orbit for an outside system (ADR 0017:
// coding briefs; the issue center reuses it). Removes e-mail addresses,
// phone numbers, credentials and keys, wallet addresses and transaction
// hashes, and counts what it removed by kind, never the removed text.

export const REDACTION_KINDS = ["secret", "email", "phone", "wallet", "tx_hash"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export type RedactionCounts = Partial<Record<RedactionKind, number>>;

// Order matters: secrets first (a key may contain digits that look like a
// phone number), transaction hashes before wallet addresses.
const PATTERNS: ReadonlyArray<[RedactionKind, RegExp]> = [
  ["secret", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["secret", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g],
  ["secret", /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["secret", /\b((?:api[_-]?key|password|passwd|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["tx_hash", /\b0x[a-fA-F0-9]{64}\b/g],
  ["wallet", /\b0x[a-fA-F0-9]{40}\b/g],
  ["wallet", /\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g],
  // International (+49 …), trunk-prefixed (0170 …) and US (555-123-4567)
  // numbers; dates, versions and plain counts stay.
  ["phone", /(?<![\w.+])(?:\+|\(?0)\d?(?:[\s()/.-]{0,2}\d){6,14}(?!\w|\.\d)/g],
  ["phone", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g],
];

const MASK: Record<RedactionKind, string> = {
  secret: "[secret removed]",
  email: "[e-mail removed]",
  phone: "[phone removed]",
  wallet: "[wallet removed]",
  tx_hash: "[transaction removed]",
};

/** The text with sensitive spans replaced, and how many of each kind. */
export function redactText(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  let out = text;
  for (const [kind, pattern] of PATTERNS)
    out = out.replace(pattern, (...args) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      // A `key = value` assignment keeps its key.
      const prefix = kind === "secret" && typeof args[1] === "string" && /[:=]\s*$/.test(args[1]) ? args[1] : "";
      return prefix + MASK[kind];
    });
  return { text: out, counts };
}

/** Adds counts of several redactions. */
export function addCounts(...all: RedactionCounts[]): RedactionCounts {
  const total: RedactionCounts = {};
  for (const counts of all)
    for (const [kind, n] of Object.entries(counts) as [RedactionKind, number][])
      total[kind] = (total[kind] ?? 0) + n;
  return total;
}
