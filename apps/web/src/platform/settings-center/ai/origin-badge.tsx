import type { Locale } from "@/lib/i18n";
import { Badge } from "@/components/ui/primitives";
import { aiText, type AiTextKey } from "./texts";
import type { AiOrigin } from "./types";

const ORIGIN_KEYS: Record<AiOrigin, AiTextKey> = {
  environment: "originEnvironment",
  system: "originSystem",
  organization: "originOrganization",
  preset: "originPreset",
  project: "originProject",
};

/**
 * Where a value comes from, in words. A deployed API can be newer than this
 * web build, so an origin outside the known list shows as itself.
 */
export function originLabel(origin: AiOrigin | null, locale: Locale): string {
  const t = aiText(locale);
  if (origin === null) return t("originNone");
  return Object.hasOwn(ORIGIN_KEYS, origin)
    ? t(ORIGIN_KEYS[origin])
    : String(origin);
}

/** The origin of a value, and "Exception" where the project departs from what it inherits. */
export function OriginBadge({
  origin,
  exception = false,
  locale,
}: {
  origin: AiOrigin | null;
  exception?: boolean;
  locale: Locale;
}) {
  return (
    <>
      <Badge tone={origin === "project" ? "blue" : "neutral"}>
        {originLabel(origin, locale)}
      </Badge>
      {exception ? (
        <Badge tone="warning">{aiText(locale)("exception")}</Badge>
      ) : null}
    </>
  );
}
