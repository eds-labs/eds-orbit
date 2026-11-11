"use client";
import { useState } from "react";
import {
  patchNoContent,
  remove,
  useMutation,
  useResource,
} from "@/lib/api";
import { Loading } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import {
  GrantList,
  revokeGrant,
  stopProposals,
  type McpGrant,
} from "@/platform/connect/connected-apps";
import type { ManageScope } from "../types";
import { useStandalone } from "@/platform/shell/standalone-context";

/** The grants API path of a scope: the member's own, or the organization's. */
export function grantsPath(scope: ManageScope): string {
  return scope.kind === "organization"
    ? `/workspaces/${encodeURIComponent(scope.organizationId)}/mcp-grants`
    : "/mcp-grants";
}

type ListProps = Omit<Parameters<typeof GrantList>[0], "grants">;

/** What the panel shows for a loaded, loading or failed list; no data access. */
export function GrantsPanelView({
  grants,
  loading,
  loadError,
  retry,
  ...list
}: ListProps & {
  grants: readonly McpGrant[] | undefined;
  loading: boolean;
  loadError: Error | null;
  retry: () => void;
}) {
  return (
    <>
      <ResourceError error={loadError} retry={retry} />
      {loading ? <Loading /> : grants && <GrantList {...list} grants={grants} />}
    </>
  );
}

/**
 * The connected apps of a scope, with the same revoke and stop-proposals
 * handlers as the project settings tab. ConnectedApps itself reads the
 * project context, which the organization and account scopes do not have,
 * so this mounts the shared GrantList directly.
 */
export function GrantsPanel({
  scope,
  showUser,
}: {
  scope: ManageScope;
  showUser: boolean;
}) {
  const { t, locale, identity } = useStandalone();
  const grants = useResource<{ grants: McpGrant[] }>(grantsPath(scope));
  const [confirm, setConfirm] = useState<McpGrant | null>(null);
  const [stopConfirm, setStopConfirm] = useState<McpGrant | null>(null);
  const mutation = useMutation(() => {
    setConfirm(null);
    setStopConfirm(null);
    grants.refresh();
  });
  return (
    <GrantsPanelView
      t={t}
      locale={locale}
      // No project here to take the time zone from: use the viewer's.
      timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      grants={grants.data?.grants}
      loading={grants.loading}
      loadError={grants.error}
      retry={grants.refresh}
      workspaceNames={
        new Map((identity?.workspaces ?? []).map((w) => [w.id, w.name]))
      }
      projectNames={
        new Map((identity?.projects ?? []).map((p) => [p.id, p.name]))
      }
      showUser={showUser}
      confirm={confirm}
      onConfirm={setConfirm}
      onRevoke={(grant) => void mutation.run(() => revokeGrant(remove, grant))}
      stopConfirm={stopConfirm}
      onStopConfirm={setStopConfirm}
      onStopProposals={(grant) =>
        void mutation.run(() => stopProposals(patchNoContent, grant))
      }
      pending={mutation.pending}
      error={mutation.error}
    />
  );
}
