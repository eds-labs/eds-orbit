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
import { useStandalone } from "@/platform/shell/standalone-context";

/**
 * The connected apps of a path (`/mcp-grants` for the member's own,
 * `/workspaces/:id/mcp-grants` for an organization), with the same revoke and
 * stop-proposals handlers as the project settings tab. ConnectedApps itself
 * reads the project context, which the organization and account scopes do not
 * have, so this mounts the shared GrantList directly.
 */
export function GrantsPanel({
  path,
  showUser,
}: {
  path: string;
  showUser: boolean;
}) {
  const { t, locale, identity } = useStandalone();
  const grants = useResource<{ grants: McpGrant[] }>(path);
  const [confirm, setConfirm] = useState<McpGrant | null>(null);
  const [stopConfirm, setStopConfirm] = useState<McpGrant | null>(null);
  const mutation = useMutation(() => {
    setConfirm(null);
    setStopConfirm(null);
    grants.refresh();
  });
  return (
    <>
      <ResourceError error={grants.error} retry={grants.refresh} />
      {grants.loading ? (
        <Loading />
      ) : (
        grants.data && (
          <GrantList
            t={t}
            locale={locale}
            // No project here to take the time zone from: use the viewer's.
            timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
            grants={grants.data.grants}
            workspaceNames={
              new Map((identity?.workspaces ?? []).map((w) => [w.id, w.name]))
            }
            projectNames={
              new Map((identity?.projects ?? []).map((p) => [p.id, p.name]))
            }
            showUser={showUser}
            confirm={confirm}
            onConfirm={setConfirm}
            onRevoke={(grant) =>
              void mutation.run(() => revokeGrant(remove, grant))
            }
            stopConfirm={stopConfirm}
            onStopConfirm={setStopConfirm}
            onStopProposals={(grant) =>
              void mutation.run(() => stopProposals(patchNoContent, grant))
            }
            pending={mutation.pending}
            error={mutation.error}
          />
        )
      )}
    </>
  );
}
