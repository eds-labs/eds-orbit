import type { Locale } from "./i18n";
import { blockerReason } from "./readiness-text";

// The capabilities of the readiness response (`readiness.capabilities`)
// as the project settings list them (WP5, 2026-11-10).

const en = {
  knowledge: "Knowledge",
  generation: "Content generation",
  social: "Social media publishing",
  blog: "Blog",
  newsletter: "Newsletter",
  ads: "Ads",
  analytics: "Analytics",
  slack: "Slack",
} as const;

export type CapabilityKey = keyof typeof en;

const de: Record<CapabilityKey, string> = {
  knowledge: "Wissen",
  generation: "Inhaltserstellung",
  social: "Social-Media-Veröffentlichung",
  blog: "Blog",
  newsletter: "Newsletter",
  ads: "Anzeigen",
  analytics: "Analysen",
  slack: "Slack",
};

const tables: Record<Locale, Record<CapabilityKey, string>> = { en, de };

/** Sentence case of a code: "MAIL_PROVIDER_MISSING" → "Mail provider missing". */
function sentence(code: string) {
  const words = code.replaceAll("_", " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A capability's name; an unknown one reads as its key in sentence case. */
export function capabilityLabel(locale: Locale, name: string): string {
  return Object.prototype.hasOwnProperty.call(en, name)
    ? (tables[locale] ?? en)[name as CapabilityKey]
    : sentence(name);
}

/**
 * What keeps a capability from live use, as a sentence: the readiness
 * text of the code, else the code in sentence case, never in capitals.
 */
export function liveBlockerText(locale: Locale, code: string): string {
  const reason = blockerReason(locale, code);
  return reason === code.replaceAll("_", " ") ? `${sentence(code)}.` : reason;
}
