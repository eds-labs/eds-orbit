import Link from "next/link";
import { Button } from "@/components/ui/primitives";
import type { Locale } from "@/lib/i18n";
import { at } from "@/platform/administration/texts";
import { StateBadge } from "./state";
import {
  authTypeLabel,
  categoryLabel,
  integrationText,
  storageLabel,
} from "./texts";
import type { CardRecord, CatalogEntry } from "./types";

/** One integration with its records, state and the way to manage it. */
export function ProviderCard({
  entry,
  records,
  manageHref,
  setupHref,
  locale,
}: {
  entry: Pick<
    CatalogEntry,
    "id" | "label" | "category" | "authType" | "storage" | "available"
  >;
  records: readonly CardRecord[];
  /** Section that manages it; null shows `managedInModule`. */
  manageHref: string | null;
  /** Guided setup address; null hides the button. */
  setupHref: string | null;
  locale: Locale;
}) {
  const text = integrationText(locale);
  const meta = [
    categoryLabel(entry.category, locale),
    authTypeLabel(entry.authType, locale),
    entry.storage.map((s) => storageLabel(s, locale)).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  // `at` answers "—" for an unparsable time; that counts as never checked.
  const lastCheck = (value: string | null) => {
    const shown = value ? at(value, locale) : "—";
    return shown === "—" ? text("neverChecked") : shown;
  };

  return (
    <article className="integration-card" data-provider={entry.id}>
      <h3>{entry.label[locale] || entry.label.en}</h3>
      <p className="integration-meta">{meta}</p>
      {!entry.available ? (
        <p>{text("switchedOff")}</p>
      ) : (
        <>
          {records.length === 0 ? (
            <StateBadge state="not_set_up" locale={locale} />
          ) : (
            <ul>
              {records.map((record) => (
                <li key={record.key}>
                  <strong>{record.label}</strong>{" "}
                  <StateBadge state={record.state} locale={locale} />
                  <span>
                    {text("lastCheck")}: {lastCheck(record.checkedAt)}
                  </span>
                  {record.detail ? <span>{record.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {manageHref === null ? (
            <p>{text("managedInModule")}</p>
          ) : (
            <Button asChild variant="outline">
              <Link href={manageHref}>{text("manage")}</Link>
            </Button>
          )}
          {setupHref !== null ? (
            <Button asChild variant="outline">
              <Link href={setupHref}>{text("setUp")}</Link>
            </Button>
          ) : null}
        </>
      )}
    </article>
  );
}
