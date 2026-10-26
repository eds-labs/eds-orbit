// Redaction of text that leaves its source for another audience (ADR 0017:
// coding briefs; ADR 0018 I-5: every stored issue report). Removes
// credentials and keys, e-mail addresses, phone numbers, IBANs, card
// numbers, IP addresses, wallet addresses and transaction hashes and the
// names a caller knows, and counts what it removed by kind, never the
// removed text. Deterministic, no AI. Support's own placeholders
// (`withPlaceholders`) are unchanged.

export const REDACTION_KINDS = [
  "secret",
  "credential_url",
  "email",
  "phone",
  "iban",
  "card",
  "ip",
  "wallet",
  "tx_hash",
  "name",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export type RedactionCounts = Partial<Record<RedactionKind, number>>;

/**
 * `strict` (the default) removes everything; `standard` keeps wallet
 * addresses and transaction hashes, which Mario ruled personal data for
 * stored reports (Q-P3-4).
 */
export type RedactionProfile = "strict" | "standard";
const STANDARD_KEEPS: ReadonlySet<RedactionKind> = new Set(["wallet", "tx_hash"]);

/** Returns the replacement, or undefined to keep the match. */
type Check = (match: string, groups: string[]) => string | undefined;
type Detector = [RedactionKind, RegExp, Check?];

const MASK: Record<RedactionKind, string> = {
  secret: "[secret removed]",
  credential_url: "[credentials removed]",
  email: "[e-mail removed]",
  phone: "[phone removed]",
  iban: "[IBAN removed]",
  card: "[card removed]",
  ip: "[IP removed]",
  wallet: "[wallet removed]",
  tx_hash: "[transaction removed]",
  name: "[name removed]",
};

/** IBAN check digits (ISO 13616): the rearranged number mod 97 is 1. */
function ibanValid(raw: string) {
  const iban = raw.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

/** Luhn check of a card number of 13 to 19 digits. */
function luhnValid(digits: string) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** An IPv6 address: eight groups, or fewer with one "::", and a digit. */
function ipv6Valid(s: string) {
  const halves = s.split("::");
  if (halves.length > 2 || !/\d/.test(s)) return false;
  const groups = halves.flatMap((h) => (h ? h.split(":") : []));
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

const keep = undefined;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

// Order matters: secrets and credential URLs first (a key may contain
// digits or an "@"), IBANs and cards before phone numbers, transaction
// hashes before wallet addresses.
const DETECTORS: readonly Detector[] = [
  ["secret", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["secret", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["secret", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/g],
  ["secret", /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["secret", /\b((?:api[_-]?key|password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi, (_m, [prefix]) => `${prefix}${MASK.secret}`],
  // User and password in a URL, and token-like query parameters.
  ["credential_url", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, [scheme]) => `${scheme}${MASK.credential_url}@`],
  ["credential_url", /([?&](?:token|access_token|id_token|refresh_token|api_key|apikey|key|secret|signature|sig|password|auth|code|session|sid|x-amz-signature)=)[^&\s#]+/gi, (_m, [prefix]) => `${prefix}${MASK.credential_url}`],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  // Grouped by four as printed (DE89 3704 0044 …) or written together. A
  // trailing word that breaks the check digits is given back.
  ["iban", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (m) => {
    for (let candidate = m; candidate.length >= 15; candidate = candidate.replace(/ ?[A-Z0-9]{1,4}$/, ""))
      if (ibanValid(candidate)) return MASK.iban + m.slice(candidate.length);
    return keep;
  }],
  // Card numbers start with 2 to 6 (so millisecond timestamps stay) and
  // pass the Luhn check.
  ["card", /(?<![\w-])[2-6](?:[ -]?\d){12,18}(?![\w-])/g, (m) => (luhnValid(m.replace(/[ -]/g, "")) ? MASK.card : keep)],
  ["ip", new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?![\\w]|\\.\\d)`, "g")],
  ["ip", /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g, (m) => (ipv6Valid(m) ? MASK.ip : keep)],
  ["tx_hash", /\b0x[a-fA-F0-9]{64}\b/g],
  ["wallet", /\b0x[a-fA-F0-9]{40}\b/g],
  ["wallet", /\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g],
  // International (+49 …), trunk-prefixed (0170 …) and US (555-123-4567)
  // numbers; dates, versions and plain counts stay.
  ["phone", /(?<![\w.+])(?:\+|\(?0)\d?(?:[\s()/.-]{0,2}\d){6,14}(?!\w|\.\d)/g],
  ["phone", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g],
];

/** Every part of the names with three or more letters, longest first. */
function namePattern(names: readonly string[]) {
  const tokens = names
    .flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)])
    .filter((t) => t.length >= 3);
  if (!tokens.length) return undefined;
  const escaped = [...new Set(tokens)]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Masks are skipped, so a name such as "Removed" cannot hit them.
  return new RegExp(`\\[[a-zA-Z -]+ removed\\]|(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * The text with sensitive spans replaced, and how many of each kind.
 * `names` are names the caller knows (a contact's name); each part with
 * three or more letters is removed in any case.
 */
export function redact(
  text: string,
  options: { names?: readonly string[]; profile?: RedactionProfile } = {},
): { text: string; counts: RedactionCounts } {
  const profile = options.profile ?? "strict";
  const counts: RedactionCounts = {};
  const hit = (kind: RedactionKind) => (counts[kind] = (counts[kind] ?? 0) + 1);
  let out = text;
  for (const [kind, pattern, check] of DETECTORS) {
    if (profile === "standard" && STANDARD_KEEPS.has(kind)) continue;
    out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g): g is string => typeof g === "string");
      const replacement = check ? check(match, groups) : MASK[kind];
      if (replacement === undefined) return match;
      hit(kind);
      return replacement;
    });
  }
  const names = namePattern(options.names ?? []);
  if (names)
    out = out.replace(names, (match) => {
      if (match.startsWith("[") && match.endsWith(" removed]")) return match;
      hit("name");
      return MASK.name;
    });
  return { text: out, counts };
}

/** Strict redaction without known names (coding briefs, ADR 0017). */
export function redactText(text: string): { text: string; counts: RedactionCounts } {
  return redact(text);
}

/** Adds counts of several redactions. */
export function addCounts(...all: RedactionCounts[]): RedactionCounts {
  const total: RedactionCounts = {};
  for (const counts of all)
    for (const [kind, n] of Object.entries(counts) as [RedactionKind, number][])
      total[kind] = (total[kind] ?? 0) + n;
  return total;
}
