"use client";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  usd,
} from "@/lib/api";
import { Alert, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

type CostRow = { unknownMicros: string; count: number };

/** The month's reservations with an unclear outcome, summed over the rows of /ai-cost. */
export function unclearMicros(rows: readonly CostRow[]) {
  return rows.reduce((n, row) => n + Number(row.unknownMicros), 0);
}

/**
 * The owner's way out of "AI cost unclear" on the home page (Operations):
 * the month's reservations whose outcome the provider never confirmed,
 * with the action that settles them at their reserved amount once the
 * owner has checked the provider's billing. Nothing for others, nothing
 * while the month has no unclear part.
 */
export function UnclearAiCost() {
  const { locale, project, isOwner, revision, refresh } = useWorkspace();
  const de = locale === "de";
  const summary = useResource<{ rows: CostRow[] }>(
    isOwner
      ? collectionPath(
          project.id,
          `ai-cost?groupBy=category&revision=${revision}`,
        )
      : null,
  );
  const mutation = useMutation(() => {
    summary.refresh();
    refresh();
  });
  const micros = unclearMicros(summary.data?.rows ?? []);
  if (!isOwner || micros <= 0) return null;
  return (
    <Alert kind="warning">
      <strong>
        {de
          ? `KI-Kosten unklar: ${usd(micros)}`
          : `AI cost unclear: ${usd(micros)}`}
      </strong>
      <p>
        {de
          ? "Reservierungen dieses Monats, deren Ergebnis der Anbieter nicht bestätigt hat (etwa Bildgenerierungen vor dieser Version oder abgebrochene Aufrufe). Das Budget zählt sie bereits mit dem reservierten Höchstbetrag. Wenn du die Abrechnung beim Anbieter geprüft hast, übernimm sie als abgerechnet; der Monatsbetrag ändert sich dadurch nicht."
          : "Reservations of this month whose outcome the provider did not confirm (such as image generations before this version or interrupted calls). The budget already counts them at the reserved ceiling. Once you have checked the provider's billing, take them over as settled; the month's total does not change."}
      </p>
      {mutation.error && <p>{mutation.error}</p>}
      <div className="form-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={mutation.pending}
          onClick={() =>
            mutation.run(() =>
              action(project.id, "settle-unknown-reservations", {}),
            )
          }
        >
          {de ? "Als abgerechnet übernehmen" : "Take over as settled"}
        </Button>
      </div>
    </Alert>
  );
}
