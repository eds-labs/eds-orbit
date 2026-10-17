"use client";
import { useState } from "react";
import { Plug } from "lucide-react";
import { remove, useMutation, useResource, when } from "@/lib/api";
import type { Locale, Text } from "@/lib/i18n";
import { useWorkspace } from "@/components/workspace-context";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { clientHost } from "./oauth-flow";

// Settings → Connected apps (Track M, WP-M1): the apps a user allowed to use
// Orbit on their behalf, with revoke, and for organization owners every app of
// the organization. The API enforces who may see and revoke what.

export type McpGrant = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  userEmail: string;
  workspaceId: string;
  projectIds: string[];
  allCurrentProjects: boolean;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
};

/** Revokes one grant. The API answers 204, so `remove` reads no body. */
export function revokeGrant(
  del: (path: string) => Promise<void>,
  grant: Pick<McpGrant, "id">,
) {
  return del(`/mcp-grants/${encodeURIComponent(grant.id)}`);
}

/** The list without data access, so it can be rendered in tests. */
export function GrantList({
  t,
  locale,
  timezone,
  grants,
  workspaceNames,
  projectNames,
  showUser,
  confirm,
  onConfirm,
  onRevoke,
  pending,
  error,
}: {
  t: Text;
  locale: Locale;
  timezone: string;
  grants: readonly McpGrant[];
  workspaceNames: ReadonlyMap<string, string>;
  projectNames: ReadonlyMap<string, string>;
  /** The owner listing names the person who connected each app. */
  showUser: boolean;
  confirm: McpGrant | null;
  onConfirm: (grant: McpGrant | null) => void;
  onRevoke: (grant: McpGrant) => void;
  pending: boolean;
  error: string | null;
}) {
  if (!grants.length) return <Empty icon={Plug} title={t("connectedEmpty")} />;
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="data-list">
        {grants.map((grant) => (
          <div className="data-row connected-app" key={grant.id}>
            <Plug aria-hidden="true" />
            <div>
              <strong>{grant.clientName}</strong>
              <p>
                <code>{clientHost(grant.clientId)}</code>
                {showUser && ` · ${t("connectedPerson")}: ${grant.userEmail}`}
              </p>
              <p>
                {workspaceNames.get(grant.workspaceId) ?? grant.workspaceId}
                {" · "}
                {grant.allCurrentProjects
                  ? t("connectedAllProjects")
                  : grant.projectIds
                      .map((id) => projectNames.get(id) ?? id)
                      .join(", ")}
              </p>
              <p>
                {t("connectedScopes")}: {grant.scopes.join(" ")}
              </p>
              <p>
                {t("connectedConnectedOn")}:{" "}
                {when(grant.createdAt, locale, timezone)}
                {" · "}
                {grant.lastUsedAt
                  ? `${t("connectedLastUsed")}: ${when(grant.lastUsedAt, locale, timezone)}`
                  : t("connectedNeverUsed")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              aria-label={`${t("connectedRevoke")}: ${grant.clientName}`}
              onClick={() => onConfirm(grant)}
            >
              {t("connectedRevoke")}
            </Button>
          </div>
        ))}
      </div>
      {confirm && (
        <Modal
          title={`${t("connectedRevokeTitle")} ${confirm.clientName}?`}
          description={t("connectedRevokeHint")}
          onClose={() => onConfirm(null)}
        >
          <div className="form-actions">
            <Button variant="outline" onClick={() => onConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => onRevoke(confirm)}
            >
              {t("connectedRevokeConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

export type GrantsResource = ReturnType<
  typeof useResource<{ grants: McpGrant[] }>
>;

/** The caller's apps, and for an owner the organization's. Rendered in the Settings tab. */
export function ConnectedApps({ mine }: { mine: GrantsResource }) {
  const { t, locale, project, identity, isOwner } = useWorkspace();
  const organization = useResource<{ grants: McpGrant[] }>(
    isOwner
      ? `/workspaces/${encodeURIComponent(project.workspaceId)}/mcp-grants`
      : null,
  );
  const [confirm, setConfirm] = useState<McpGrant | null>(null);
  const mutation = useMutation(() => {
    setConfirm(null);
    mine.refresh();
    organization.refresh();
  });
  const workspaceNames = new Map(
    identity.workspaces.map((w) => [w.id, w.name]),
  );
  const projectNames = new Map(identity.projects.map((p) => [p.id, p.name]));
  const common = {
    t,
    locale,
    timezone: project.timezone,
    workspaceNames,
    projectNames,
    confirm,
    onConfirm: setConfirm,
    onRevoke: (grant: McpGrant) =>
      void mutation.run(() => revokeGrant(remove, grant)),
    pending: mutation.pending,
    error: mutation.error,
  };
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t("connectedApps")}</h2>
            <p>{t("connectedAppsHint")}</p>
          </div>
        </div>
        <ResourceError error={mine.error} retry={mine.refresh} />
        {mine.loading ? (
          <Loading />
        ) : (
          mine.data && (
            <GrantList {...common} grants={mine.data.grants} showUser={false} />
          )
        )}
      </section>
      {isOwner && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t("connectedOrgTitle")}</h2>
              <p>{t("connectedOrgHint")}</p>
            </div>
            <Badge>{workspaceNames.get(project.workspaceId)}</Badge>
          </div>
          <ResourceError
            error={organization.error}
            retry={organization.refresh}
          />
          {organization.loading ? (
            <Loading />
          ) : (
            organization.data && (
              <GrantList
                {...common}
                grants={organization.data.grants}
                showUser
              />
            )
          )}
        </section>
      )}
    </>
  );
}
