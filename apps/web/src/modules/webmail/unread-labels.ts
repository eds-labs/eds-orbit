import type { Locale } from "@/lib/i18n";

export function unreadTotalLabel(
  count: number,
  complete: boolean,
  locale: Locale,
) {
  if (!complete && count === 0)
    return locale === "de"
      ? "Gesamtzahl ungelesener E-Mails derzeit unvollständig"
      : "Total unread email count incomplete";
  const number = count.toLocaleString(locale);
  if (locale === "de") {
    const emails = count === 1 ? "ungelesene E-Mail" : "ungelesene E-Mails";
    return complete
      ? `${number} ${emails} insgesamt`
      : `Mindestens ${number} ${emails} insgesamt`;
  }
  const emails = count === 1 ? "unread email" : "unread emails";
  return complete
    ? `${number} ${emails} in total`
    : `At least ${number} ${emails} in total`;
}

export function mailboxUnreadLabel(
  count: number | null | undefined,
  locale: Locale,
) {
  if (count === undefined) return undefined;
  if (count === null)
    return locale === "de" ? "Ungelesen: unbekannt" : "Unread: unknown";
  return locale === "de"
    ? `${count.toLocaleString(locale)} ungelesen`
    : `${count.toLocaleString(locale)} unread`;
}
