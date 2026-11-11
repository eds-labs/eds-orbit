import { Badge } from "@/components/ui/primitives";
import type { Locale } from "@/lib/i18n";
import { stateLabel } from "./texts";
import type { IntegrationState } from "./types";

/** Tone per state; the server derives the state, the web only colours it. */
export const stateTone: Record<
  IntegrationState,
  "neutral" | "warning" | "success" | "danger"
> = {
  not_set_up: "neutral",
  stored: "warning",
  verified: "success",
  ready: "success",
  needs_attention: "danger",
  disabled: "neutral",
};

/** The state as text; colour only supports the label, never replaces it. */
export function StateBadge({
  state,
  locale,
}: {
  state: IntegrationState;
  locale: Locale;
}) {
  return <Badge tone={stateTone[state]}>{stateLabel(state, locale)}</Badge>;
}
