"use client";
import { useEffect, useState } from "react";
import { Alert, Loading } from "@/components/ui/primitives";
import { api, ApiError } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { useStandalone } from "@/platform/shell/standalone-context";

// The public status page of a Meta data-deletion request for the ads app
// (ADR 0025). Meta sends people here with the confirmation code Orbit
// returned; the request was carried out before the code was issued, so a
// code the server verifies is a completed request. No session needed.

export type DeletionState =
  | { kind: "loading" }
  | { kind: "done"; requestedAt: string }
  | { kind: "unknown" }
  | { kind: "error" };

const CODE = /^[a-f0-9]{42}$/;

/** The confirmation code from the page's query, if it has the right shape. */
export function codeOf(search: string): string | null {
  const code = new URLSearchParams(search).get("code");
  return code && CODE.test(code) ? code : null;
}

const texts = {
  en: {
    title: "Your data-deletion request",
    checking: "Checking the request…",
    code: "Confirmation code",
    requested: "Received",
    done: "Completed",
    removed:
      "Orbit disconnected every ad account that was connected with your Meta login, in every project, and deleted the access tokens. Orbit can no longer read or change anything with them.",
    kept: "Campaigns at Meta are not touched; you can manage or delete them in Meta's own tools. Figures Orbit already stored stay with the project, together with the names of the disconnected accounts.",
    unknown:
      "Orbit does not know this confirmation code. Check the code in Facebook's confirmation, or ask the owner of the Orbit project.",
    error: "The status could not be loaded. Try again later.",
  },
  de: {
    title: "Ihre Anfrage zur Datenlöschung",
    checking: "Anfrage wird geprüft…",
    code: "Bestätigungscode",
    requested: "Eingegangen",
    done: "Erledigt",
    removed:
      "Orbit hat jedes Werbekonto, das mit Ihrem Meta-Login verbunden war, in allen Projekten getrennt und die Zugriffstoken gelöscht. Orbit kann damit nichts mehr lesen oder ändern.",
    kept: "Kampagnen bei Meta werden nicht angetastet; Sie können sie in den Werkzeugen von Meta selbst verwalten oder löschen. Zahlen, die Orbit bereits gespeichert hat, bleiben beim Projekt, zusammen mit den Namen der getrennten Konten.",
    unknown:
      "Orbit kennt diesen Bestätigungscode nicht. Prüfen Sie den Code in der Bestätigung von Facebook oder wenden Sie sich an den Inhaber des Orbit-Projekts.",
    error: "Der Status konnte nicht geladen werden. Versuchen Sie es später erneut.",
  },
} as const;

export function AdsDataDeletionStatus({ locale, code, state }: { locale: Locale; code: string | null; state: DeletionState }) {
  const t = texts[locale];
  if (state.kind === "loading") return <Loading label={t.checking} />;
  return (
    <div className="picker">
      <h1>{t.title}</h1>
      {state.kind === "done" && code ? (
        <>
          <dl>
            <dt>{t.code}</dt>
            <dd>
              <code>{code}</code>
            </dd>
            <dt>{t.requested}</dt>
            <dd>{new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(state.requestedAt))}</dd>
          </dl>
          <Alert kind="success">{t.done}</Alert>
          <p>{t.removed}</p>
          <p>{t.kept}</p>
        </>
      ) : (
        <Alert kind="error">{state.kind === "error" ? t.error : t.unknown}</Alert>
      )}
    </div>
  );
}

export function AdsDataDeletionView() {
  const { locale } = useStandalone();
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<DeletionState>({ kind: "loading" });
  useEffect(() => {
    const found = codeOf(window.location.search);
    setCode(found);
    if (!found) {
      setState({ kind: "unknown" });
      return;
    }
    api<{ status: "completed"; requestedAt: string }>(`/public/ads/data-deletion/${found}`)
      .then((status) => setState({ kind: "done", requestedAt: status.requestedAt }))
      .catch((error: unknown) =>
        setState(error instanceof ApiError && error.status === 404 ? { kind: "unknown" } : { kind: "error" }),
      );
  }, []);
  return <AdsDataDeletionStatus locale={locale} code={code} state={state} />;
}
