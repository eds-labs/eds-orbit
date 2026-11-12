"use client";
import { useContext } from "react";
import Link from "next/link";
import { usd } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Badge } from "@/components/ui/primitives";
import { ShellContext } from "@/platform/shell/shell-context";
import { aiText } from "./texts";

type CeilingRow = {
  key: string;
  moduleName: string;
  label: string;
  micros: number;
  period: "day" | "month";
  on?: boolean;
  href: string;
};

/** The modules' AI ceilings, read-only; each links to the module section that edits it. */
export function ModuleCeilingsView({
  rows,
  locale,
}: {
  rows: readonly CeilingRow[];
  locale: Locale;
}) {
  const t = aiText(locale);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>{t("ceilingsTitle")}</h3>
          <p>{t("ceilingsIntro")}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="panel-note">{t("ceilingsNone")}</p>
      ) : (
        <div className="capability-readiness">
          {rows.map((row) => (
            <div className="data-row" key={row.key}>
              <div>
                <strong>{`${row.moduleName}: ${row.label}`}</strong>
                <p>
                  {`${usd(row.micros)} ${t(row.period === "day" ? "perDay" : "perMonth")}`}
                </p>
              </div>
              {row.on === false ? <Badge>{t("ceilingOff")}</Badge> : null}
              <Link href={row.href}>{t("openSetting")}</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The ceilings of the modules shown for the project. Every entry's hook runs
 * on every render in the shell's order: the list only changes with the
 * enabled modules, and then the shell remounts the project scope.
 */
export function ModuleCeilings({
  locale,
  hrefOf,
}: {
  locale: Locale;
  hrefOf(area: string, ...rest: string[]): string;
}) {
  const shell = useContext(ShellContext);
  const entries = shell?.aiCeilings ?? [];
  const values = entries.map((entry) => entry.useCeiling());
  const rows = entries.flatMap((entry, index): CeilingRow[] => {
    const value = values[index];
    if (!value) return [];
    const module = shell?.modules.find((m) => m.id === entry.moduleId);
    return [
      {
        key: `${entry.moduleId}/${entry.key}`,
        moduleName: module
          ? module.displayName[locale] || module.displayName.en
          : entry.moduleId,
        label: entry.label[locale] || entry.label.en,
        micros: value.micros,
        period: value.period,
        on: value.on,
        href: hrefOf("modules", ...entry.section.split("/")),
      },
    ];
  });
  return <ModuleCeilingsView rows={rows} locale={locale} />;
}
