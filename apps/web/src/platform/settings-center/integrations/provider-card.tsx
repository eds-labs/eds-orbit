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
  type IntegrationTextKey,
} from "./texts";
import type { CardRecord, CatalogEntry, ManageNote } from "./types";

export const NOTE_TEXT: Record<ManageNote, IntegrationTextKey> = {
  module: "managedInModule",
  organization: "managedInOrganization",
  server: "managedOnServer",
};

/** One integration with its records, state and the way to manage it. */
export function ProviderCard({
  entry,
  records,
  manageHref,
  manageNote,
  setupHref,
  locale,
}: {
  entry: Pick<
    CatalogEntry,
    "id" | "label" | "category" | "authType" | "storage" | "available"
  >;
  records: readonly CardRecord[];
  /** Section that manages it; null shows the note instead. */
  manageHref: string | null;
  /** Why there is no Manage link (scopes.ts `manageNote`); null shows no note. */
  manageNote: ManageNote | null;
  /** Guided setup address; null hides the button. */
  setupHref: string | null;
  locale: Locale;
}) {
  const text = integrationText(locale);
  // A value of a newer API must not break the card.
  const storage: readonly string[] = Array.isArray(entry.storage) ? entry.storage : [];
  const meta = [
    categoryLabel(entry.category, locale),
    authTypeLabel(entry.authType, locale),
    storage.map((s) => storageLabel(s as CatalogEntry["storage"][number], locale)).join(", "),
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
      <h4>{entry.label[locale] || entry.label.en}</h4>
      <p className="integration-meta">{meta}</p>
      {!entry.available ? (
        <p>{text("switchedOff")}</p>
      ) : (
        <>
          {records.length === 0 ? (
            // The environment's state is known only in the environment panel.
            storage.includes("environment") ? null : (
              <StateBadge state="not_set_up" locale={locale} />
            )
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
          {/* Note and actions sit at the bottom, so cards of a row align. */}
          <div className="integration-card-foot">
            {manageHref === null && manageNote !== null && Object.hasOwn(NOTE_TEXT, manageNote) ? (
              <p>{text(NOTE_TEXT[manageNote])}</p>
            ) : null}
            {manageHref !== null || setupHref !== null ? (
              <div className="integration-actions">
                {manageHref !== null ? (
                  <Button asChild variant="outline">
                    <Link href={manageHref}>{text("manage")}</Link>
                  </Button>
                ) : null}
                {setupHref !== null ? (
                  <Button asChild variant="outline">
                    <Link href={setupHref}>{text("setUp")}</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </article>
  );
}
