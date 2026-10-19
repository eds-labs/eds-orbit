"use client";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead } from "@/platform/ui/collection";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { Assignments, ASSIGNMENTS_TEXT, useAssignments } from "./assignments";

/**
 * The assignments as a Marketing page (2026-10-19; before, a section of the
 * project settings). They are what the agents do day to day, with status,
 * next run and month cost, so they sit with missions and content. Without
 * Orbit Agents (its route answers 404) the page says so instead of hiding.
 */
export function AssignmentsPage() {
  const { locale } = useWorkspace();
  const assignments = useAssignments();
  return (
    <>
      <PageHead
        title={ASSIGNMENTS_TEXT.title[locale]}
        description={ASSIGNMENTS_TEXT.description[locale]}
      >
        <Button asChild variant="outline">
          <AppLink href="/chat">{ASSIGNMENTS_TEXT.change[locale]}</AppLink>
        </Button>
      </PageHead>
      {assignments.surface === "unavailable" ? (
        <section className="panel">
          <p className="panel-note">
            {locale === "de"
              ? "Orbit Agents ist für dieses Projekt nicht aktiviert; es gibt keine Aufträge."
              : "Orbit Agents is not enabled for this project; there are no assignments."}
          </p>
        </section>
      ) : (
        <Assignments
          resource={assignments.resource}
          data={assignments.data}
          headless
        />
      )}
    </>
  );
}
