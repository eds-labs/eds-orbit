"use client";
import { ActionRequestInbox } from "@/components/action-request-inbox";
import { useWorkspace } from "@/components/workspace-context";
import { useResource } from "@/lib/api";
import { PageHead } from "@/platform/ui/collection";
import { AppLink } from "@/platform/ui/app-link";
import { expiresIn } from "./approval-presentation";

type ProjectDecisions = {
  projectId: string;
  projectName: string;
  count: number;
  firstExpiresAt: string | null;
};

/** Shared action requests stay reachable independently of any product module. */
export function Decisions() {
  const { locale, project } = useWorkspace();
  const de = locale === "de";
  return (
    <>
      <PageHead
        title={de ? "Freigaben" : "Approvals"}
        description={
          de
            ? "Entscheidungen zu Support-Nachrichten und anderen App-Aktionen."
            : "Decisions for support messages and other app actions."
        }
      />
      <ActionRequestInbox showEmpty />
      <OtherProjects currentProjectId={project.id} de={de} />
    </>
  );
}

/**
 * Open decisions in the member's other projects, as counts: each is
 * decided in its own project, with that project's rules (Approval UX v2).
 */
export function OtherProjects({
  currentProjectId,
  de,
}: {
  currentProjectId: string;
  de: boolean;
}) {
  const summary = useResource<{ items: ProjectDecisions[] }>(
    "/action-requests/summary",
  );
  const others = (summary.data?.items ?? []).filter(
    (item) => item.projectId !== currentProjectId,
  );
  if (!others.length) return null;
  return (
    <section
      className="panel"
      aria-label={de ? "Freigaben in anderen Projekten" : "Approvals in other projects"}
    >
      <h2>{de ? "Freigaben in anderen Projekten" : "Approvals in other projects"}</h2>
      <ul className="data-list">
        {others.map((item) => (
          <li key={item.projectId} className="data-row">
            <div>
              <strong>{item.projectName}</strong>
              <p>
                {de
                  ? `${item.count} offen`
                  : `${item.count} open`}
                {item.firstExpiresAt &&
                  ` · ${de ? "erste läuft ab" : "first expires"} ${expiresIn(item.firstExpiresAt, de)}`}
              </p>
            </div>
            <AppLink href={`/p/${encodeURIComponent(item.projectId)}/decisions`}>
              {de ? "Öffnen" : "Open"}
            </AppLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
