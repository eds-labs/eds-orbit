"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { supportPath, type Summary } from "./api";
import { supportText } from "./labels";

/** The support tile of the project home: open, unassigned and SLA counts. */
export function SupportHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const summary = useResource<Summary>(supportPath(project.id, "/summary"));
  if (!summary.data) return null;
  const s = summary.data;
  return (
    <section className="panel support-home" aria-label={t.home.title}>
      <div className="panel-head">
        <h2>{t.home.title}</h2>
      </div>
      <dl className="support-home-counts">
        <div>
          <dt>{t.home.open}</dt>
          <dd>{s.open}</dd>
        </div>
        <div>
          <dt>{t.home.unassigned}</dt>
          <dd>{s.unassigned}</dd>
        </div>
        <div>
          <dt>{t.home.atRisk}</dt>
          <dd>{s.atRisk}</dd>
        </div>
        <div>
          <dt>{t.home.breached}</dt>
          <dd>{s.breached}</dd>
        </div>
      </dl>
      <AppLink href={shell.hrefOf("support")}>{t.home.link}</AppLink>
    </section>
  );
}
