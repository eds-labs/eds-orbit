"use client";
import { useState } from "react";
import { put, remove, useMutation, useResource, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, type FormField } from "@/platform/ui/form";
import { errorText } from "./texts";

// "Modelle & Preise" (plans/ai-central-management.md, phase A): Orbit's dated
// price catalog with the system's (administrators) or the organization's
// (owners) overrides. Prices are entered in USD in a form; the API stores
// micros. Every project of the organization draws on this list.

type CatalogRow = {
  id: string;
  provider: "openai" | "anthropic";
  purpose: "text" | "image" | "embedding";
  displayName: string;
  rate?: {
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    cachedInputMicrosPerMillion?: number;
  };
  perImageMicros?: number;
  verifiedAt: string;
  source: string;
  note?: string;
  active: boolean;
  priceSource: "orbit" | "system" | "organization";
  needsReview: boolean;
  overridden: boolean;
};

const usd = (micros: number | undefined, digits = 2) =>
  micros === undefined ? "—" : `$${(micros / 1_000_000).toFixed(digits)}`;
const toMicros = (value: unknown) => Math.round(Number(value) * 1_000_000);

const text = {
  en: {
    title: "Models & prices",
    intro:
      "Orbit ships dated prices for OpenAI and Claude. Every project draws on this list; a project's own prices (advanced) still win. Change a price here once instead of per project.",
    purpose: { text: "Text", image: "Image", embedding: "Search (embeddings)" },
    source: { orbit: "Orbit", system: "System", organization: "Organization" },
    perMillion: "per 1M tokens (input / output)",
    perImage: "booked per image",
    checked: "checked",
    review: "please check",
    off: "off",
    edit: "Edit",
    reset: "Reset",
    modal: "Price",
    active: "Available to projects",
    input: "Input (USD per 1M tokens)",
    cached: "Cached input (USD per 1M tokens)",
    output: "Output (USD per 1M tokens)",
    image: "Booked per image (USD)",
    imageHint:
      "OpenAI publishes only token prices for GPT Image 2.5; Orbit books this amount per image.",
    save: "Save",
    savedNote: "Saving dates the price today.",
  },
  de: {
    title: "Modelle & Preise",
    intro:
      "Orbit liefert datierte Preise für OpenAI und Claude mit. Alle Projekte nutzen diese Liste; eigene Preise eines Projekts (Erweitert) gehen weiter vor. Einen Preis änderst du hier einmal statt pro Projekt.",
    purpose: { text: "Text", image: "Bild", embedding: "Suche (Embeddings)" },
    source: { orbit: "Orbit", system: "System", organization: "Organisation" },
    perMillion: "pro 1 Mio. Tokens (Eingabe / Ausgabe)",
    perImage: "gebucht pro Bild",
    checked: "geprüft",
    review: "bitte prüfen",
    off: "aus",
    edit: "Bearbeiten",
    reset: "Zurücksetzen",
    modal: "Preis",
    active: "Für Projekte verfügbar",
    input: "Eingabe (USD pro 1 Mio. Tokens)",
    cached: "Gecachte Eingabe (USD pro 1 Mio. Tokens)",
    output: "Ausgabe (USD pro 1 Mio. Tokens)",
    image: "Gebucht pro Bild (USD)",
    imageHint:
      "OpenAI veröffentlicht für GPT Image 2.5 nur Token-Preise; Orbit bucht pro Bild diesen Betrag.",
    save: "Speichern",
    savedNote: "Beim Speichern wird der Preis auf heute datiert.",
  },
} as const;

export function ModelPricesPanel({
  path,
  locale,
}: {
  /** "/admin/ai/models" or "/organizations/:id/ai/models". */
  path: string;
  locale: Locale;
}) {
  const t = text[locale === "de" ? "de" : "en"];
  const list = useResource<{ models: CatalogRow[] }>(path);
  const [editing, setEditing] = useState<CatalogRow | null>(null);
  const reset = useMutation(list.refresh);
  if (list.loading && !list.data) return <Loading />;
  if (!list.data) return <ResourceError error={list.error} retry={list.refresh} />;
  const groups = (["anthropic", "openai"] as const).map((provider) => ({
    provider,
    rows: list.data!.models.filter((m) => m.provider === provider),
  }));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
      </div>
      {reset.error && <Alert kind="error">{errorText(reset.error, locale)}</Alert>}
      <div className="capability-readiness">
        {groups.map(({ provider, rows }) =>
          rows.map((m) => (
            <div className="data-row" key={m.id}>
              <div>
                <strong>
                  {m.displayName} · {m.id}
                </strong>
                <p>
                  {provider === "anthropic" ? "Claude" : "OpenAI"} · {t.purpose[m.purpose]}
                  {" · "}
                  {m.purpose === "image"
                    ? `${usd(m.perImageMicros, 3)} ${t.perImage}`
                    : m.rate
                      ? `${usd(m.rate.inputMicrosPerMillion)} / ${usd(m.rate.outputMicrosPerMillion)} ${t.perMillion}`
                      : "—"}
                  {" · "}
                  {t.checked} {when(m.verifiedAt, locale).split(",")[0]} ({t.source[m.priceSource]})
                </p>
              </div>
              {m.needsReview && <Badge tone="warning">{t.review}</Badge>}
              {!m.active && <Badge tone="neutral">{t.off}</Badge>}
              <div className="page-actions">
                <Button variant="outline" onClick={() => setEditing(m)}>
                  {t.edit}
                </Button>
                {m.overridden && (
                  <Button
                    variant="outline"
                    disabled={reset.pending}
                    onClick={() =>
                      reset.run(() => remove(`${path}/${encodeURIComponent(m.id)}`))
                    }
                  >
                    {t.reset}
                  </Button>
                )}
              </div>
            </div>
          )),
        )}
      </div>
      {editing && (
        <PriceForm
          row={editing}
          path={path}
          locale={locale}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.refresh();
          }}
        />
      )}
    </section>
  );
}

function PriceForm({
  row,
  path,
  locale,
  onClose,
  onSaved,
}: {
  row: CatalogRow;
  path: string;
  locale: Locale;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = text[locale === "de" ? "de" : "en"];
  const mutation = useMutation(onSaved);
  const dollars = (micros: number | undefined) =>
    micros === undefined ? "" : String(micros / 1_000_000);
  const fields: FormField[] = [
    { name: "active", label: t.active, type: "checkbox", value: row.active },
    ...(row.purpose === "image"
      ? [
          {
            name: "perImage",
            label: t.image,
            type: "number" as const,
            min: 0,
            max: 10,
            step: "0.001",
            required: true,
            value: dollars(row.perImageMicros),
            hint: t.imageHint,
          },
        ]
      : [
          {
            name: "input",
            label: t.input,
            type: "number" as const,
            min: 0,
            step: "0.001",
            required: true,
            value: dollars(row.rate?.inputMicrosPerMillion),
          },
          ...(row.purpose === "text"
            ? [
                {
                  name: "cached",
                  label: t.cached,
                  type: "number" as const,
                  min: 0,
                  step: "0.001",
                  value: dollars(row.rate?.cachedInputMicrosPerMillion),
                },
                {
                  name: "output",
                  label: t.output,
                  type: "number" as const,
                  min: 0,
                  step: "0.001",
                  required: true,
                  value: dollars(row.rate?.outputMicrosPerMillion),
                },
              ]
            : []),
        ]),
  ];
  return (
    <Modal title={`${t.modal}: ${row.displayName}`} onClose={onClose}>
      <p className="panel-note">{t.savedNote}</p>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error ? errorText(mutation.error, locale) : null}
        submitLabel={t.save}
        onCancel={onClose}
        onSubmit={(v) =>
          mutation.run(() => {
            const changed = (key: string, current: number | undefined) =>
              String(v[key] ?? "") !== "" && toMicros(v[key]) !== current;
            return put(`${path}/${encodeURIComponent(row.id)}`, {
              ...(v.active !== row.active ? { active: v.active === true } : {}),
              ...(row.purpose === "image"
                ? changed("perImage", row.perImageMicros)
                  ? { perImageMicros: toMicros(v.perImage) }
                  : {}
                : {
                    ...(changed("input", row.rate?.inputMicrosPerMillion)
                      ? { inputMicrosPerMillion: toMicros(v.input) }
                      : {}),
                    ...(row.purpose === "text" &&
                    changed("cached", row.rate?.cachedInputMicrosPerMillion)
                      ? { cachedInputMicrosPerMillion: toMicros(v.cached) }
                      : {}),
                    ...(row.purpose === "text" &&
                    changed("output", row.rate?.outputMicrosPerMillion)
                      ? { outputMicrosPerMillion: toMicros(v.output) }
                      : {}),
                  }),
            });
          })
        }
      />
    </Modal>
  );
}
