"use client";
// The agents of every project of an organization (ADR 0021, WP1.8) at
// /o/:orgId/agents: counts per project from GET /api/agents/summary, which
// lists only projects the member may read agents in and that have any.
import Link from "next/link";
import { Bot } from "lucide-react";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Empty, Loading } from "@/components/ui/primitives";
import { agentPaths, errorCode } from "./api";
import { AgentsUnavailable } from "./agents-view";
import type { AgentsSummary } from "./types";

/** The summary rows of one organization (the API answers for all of the member's). */
export const organizationRows = (
  summary: AgentsSummary | null,
  organizationId: string,
) => (summary?.items ?? []).filter((row) => row.workspaceId === organizationId);

export function OrganizationAgents({
  organizationId,
  locale,
}: {
  organizationId: string;
  locale: Locale;
}) {
  const de = locale === "de";
  const summary = useResource<AgentsSummary>(agentPaths.summary());
  const rows = organizationRows(summary.data, organizationId);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{de ? "Agenten aller Projekte" : "Agents of all projects"}</h1>
          <p>
            {de
              ? "Projekte, in denen du Agenten sehen darfst und in denen es aktive, pausierte oder fehlerhafte Agenten gibt."
              : "Projects where you may see agents and that have active, paused or failing agents."}
          </p>
        </div>
      </div>
      {summary.loading && !summary.data && <Loading />}
      {summary.error && (
        <AgentsUnavailable code={errorCode(summary.error)} locale={locale} />
      )}
      {summary.data && !rows.length && (
        <Empty
          icon={Bot}
          title={de ? "Keine laufenden Agenten" : "No running agents"}
          description={
            de
              ? "In dieser Organisation gibt es in deinen Projekten keine aktiven, pausierten oder fehlerhaften Agenten."
              : "Your projects in this organization have no active, paused or failing agents."
          }
        />
      )}
      {rows.length > 0 && (
        <section className="panel" aria-labelledby="org-agents-title">
          <div className="panel-head">
            <div>
              <h2 id="org-agents-title">{de ? "Projekte" : "Projects"}</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{de ? "Projekt" : "Project"}</th>
                  <th scope="col">{de ? "Aktiv" : "Active"}</th>
                  <th scope="col">{de ? "Pausiert" : "Paused"}</th>
                  <th scope="col">
                    {de ? "Mit Fehlern (24 h)" : "Failing (24 h)"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.projectId}>
                    <td>
                      <Link
                        href={`/p/${encodeURIComponent(row.projectId)}/agents`}
                      >
                        {row.projectName}
                      </Link>
                    </td>
                    <td>{row.active}</td>
                    <td>{row.paused}</td>
                    <td>{row.failing24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
