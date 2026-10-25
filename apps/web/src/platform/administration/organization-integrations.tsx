"use client";
import type { Identity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { ConnectionsPanel } from "./connections-ui";
import { AiProfileEditor, KnowledgeSharesPanel } from "./ai-knowledge-ui";
import { ModelPricesPanel } from "./ai-catalog-ui";

/**
 * The organization's connections, AI profile and shared knowledge (ADR
 * 0013), for its owners; shown only while the features are on. The API
 * refuses everyone else.
 */
export function OrganizationIntegrations({
  identity,
  organizationId,
  locale,
}: {
  identity: Identity;
  organizationId: string;
  locale: Locale;
}) {
  const owner = identity.workspaces.some(
    (w) => w.id === organizationId && w.role === "owner",
  );
  if (!owner) return null;
  const projects = identity.projects
    .filter((p) => p.workspaceId === organizationId)
    .map((p) => ({ id: p.id, name: p.name }));
  const base = `/organizations/${encodeURIComponent(organizationId)}`;
  return (
    <div className="admin-stack admin-stack-spaced">
      {identity.connections && (
        <>
          <ConnectionsPanel
            base={`${base}/connections`}
            mode="owner"
            locale={locale}
            targets={projects}
          />
          <ModelPricesPanel path={`${base}/ai/models`} locale={locale} />
          <AiProfileEditor
            path={`${base}/ai/profile`}
            locale={locale}
            scopeLabel={locale === "de" ? "Organisation" : "Organization"}
          />
        </>
      )}
      {identity.knowledgeShares && (
        <KnowledgeSharesPanel
          organizationId={organizationId}
          projects={projects}
          locale={locale}
        />
      )}
    </div>
  );
}
