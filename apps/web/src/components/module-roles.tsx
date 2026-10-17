"use client";
// A member's roles per module (WP4.5): owners set editor, viewer or no
// access for one module; the project role applies everywhere else.
import { api, collectionPath, useMutation, useResource } from "@/lib/api";
import { Alert, Loading, Modal } from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";

type ModuleList = {
  modules: Array<{ id: string; displayName: { en: string; de: string } }>;
};
type Roles = { userId: string; roles: Record<string, string> };

/** The PUT body: every module, "" for the project role (no override). */
export function moduleRolesBody(
  moduleIds: readonly string[],
  values: Record<string, string>,
): { roles: Record<string, string | null> } {
  return {
    roles: Object.fromEntries(
      moduleIds.map((id) => [id, values[id] ? values[id] : null]),
    ),
  };
}

export function ModuleRoles({
  userId,
  name,
  projectRole,
  onClose,
}: {
  userId: string;
  name: string;
  projectRole: string;
  onClose(): void;
}) {
  const { project, locale, t } = useWorkspace();
  const modules = useResource<ModuleList>(
    collectionPath(project.id, "modules"),
  );
  const roles = useResource<Roles>(
    collectionPath(
      project.id,
      `members/${encodeURIComponent(userId)}/module-roles`,
    ),
  );
  const mutation = useMutation(onClose);
  const ids = (modules.data?.modules ?? []).map((m) => m.id);
  return (
    <Modal
      title={`Module roles · ${name}`}
      description={`Project role: ${projectRole}. A module role replaces it in that module only; "No access" hides the module.`}
      onClose={onClose}
    >
      {modules.loading || roles.loading ? (
        <Loading />
      ) : roles.error?.status === 404 ? (
        <Alert>Module roles are switched off for this installation.</Alert>
      ) : (
        <>
          <ResourceError
            error={modules.error ?? roles.error}
            retry={roles.refresh}
          />
          <DataForm
            fields={(modules.data?.modules ?? []).map((m) => ({
              name: m.id,
              label: m.displayName[locale],
              type: "select" as const,
              value: roles.data?.roles[m.id] ?? "",
              options: [
                { value: "", label: `Project role (${projectRole})` },
                { value: "editor", label: "Editor" },
                { value: "viewer", label: "Viewer" },
                { value: "none", label: "No access" },
              ],
            }))}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={onClose}
            submitLabel={t("save")}
            onSubmit={(v) =>
              mutation.run(() =>
                api(
                  `/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(userId)}/module-roles`,
                  {
                    method: "PUT",
                    body: JSON.stringify(
                      moduleRolesBody(
                        ids,
                        Object.fromEntries(ids.map((id) => [id, str(v, id)])),
                      ),
                    ),
                  },
                ),
              )
            }
          />
        </>
      )}
    </Modal>
  );
}
