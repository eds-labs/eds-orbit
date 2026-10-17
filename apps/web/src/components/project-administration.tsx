"use client";
// Project members and administration (WP2.3b), moved unchanged from the marketing module (platform UI).
import { useState } from "react";
import { Settings, UserPlus } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  value,
} from "@/lib/api";
import { Badge, Button, Modal, Loading } from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { ModuleRoles } from "./module-roles";
export function ProjectAdministration() {
  const { project, isOwner, t, refresh } = useWorkspace();
  const members = useResource<{ items: Array<Record<string, unknown>> }>(
    isOwner ? collectionPath(project.id, "members") : null,
  );
  const [mode, setMode] = useState<"project" | "member" | null>(null);
  const [rolesFor, setRolesFor] = useState<{
    userId: string;
    name: string;
    projectRole: string;
  } | null>(null);
  const mutation = useMutation(() => {
    refresh();
    members.refresh();
    setMode(null);
  });
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <h2>Project access</h2>
        <div className="page-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMode("project")}
          >
            <Settings data-icon="inline-start" />
            Edit project
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMode("member")}>
            <UserPlus data-icon="inline-start" />
            Add member
          </Button>
        </div>
      </div>
      <ResourceError error={members.error} retry={members.refresh} />
      {members.loading ? (
        <Loading />
      ) : members.data?.items.length ? (
        <div className="member-list">
          {members.data.items.map((m, i) => {
            const user = m.user as Record<string, unknown> | undefined;
            return (
              <div className="member-row" key={String(m.id || i)}>
                <div>
                  <strong>{String(user?.name || m.name || "Member")}</strong>
                  <small>{String(user?.email || m.email || "")}</small>
                </div>
                <div className="page-actions">
                  <Badge>{String(m.role || "member")}</Badge>
                  {m.role !== "owner" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setRolesFor({
                          userId: String(m.userId),
                          name: String(user?.name || "Member"),
                          projectRole: String(m.role),
                        })
                      }
                    >
                      Module roles
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="panel-note">No additional members.</p>
      )}
      {rolesFor && (
        <ModuleRoles {...rolesFor} onClose={() => setRolesFor(null)} />
      )}
      {mode && (
        <Modal
          title={mode === "project" ? "Edit project" : "Add local member"}
          description={
            mode === "member"
              ? "Creates a local identity and project membership. No email is sent. Share credentials through your own approved secure process."
              : undefined
          }
          onClose={() => setMode(null)}
        >
          <DataForm
            fields={
              mode === "project"
                ? [
                    {
                      name: "name",
                      label: t("name"),
                      value: project.name,
                      required: true,
                    },
                    {
                      name: "timezone",
                      label: t("timezone"),
                      value: project.timezone,
                      required: true,
                    },
                    {
                      name: "language",
                      label: "Content language",
                      type: "select",
                      value: project.language,
                      options: [
                        { value: "en", label: "English" },
                        { value: "de", label: "Deutsch" },
                      ],
                    },
                  ]
                : [
                    { name: "name", label: t("name"), required: true },
                    {
                      name: "email",
                      label: "Email",
                      type: "email",
                      required: true,
                    },
                    {
                      name: "password",
                      label: "Initial password",
                      type: "password",
                      required: true,
                      hint: "At least 12 characters. Not retained in browser storage.",
                    },
                    {
                      name: "role",
                      label: "Project role",
                      type: "select",
                      value: "viewer",
                      options: [
                        { value: "viewer", label: "Viewer · read only" },
                        {
                          value: "editor",
                          label: "Editor · content and review",
                        },
                        {
                          value: "owner",
                          label: "Owner · full project authority",
                        },
                      ],
                    },
                  ]
            }
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={() => setMode(null)}
            submitLabel={t("save")}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(
                    project.id,
                    mode === "project" ? "project-settings" : "add-member",
                    mode === "project"
                      ? {
                          name: str(v, "name"),
                          timezone: str(v, "timezone"),
                          language: str(v, "language"),
                        }
                      : {
                          name: str(v, "name"),
                          email: str(v, "email"),
                          password: String(v.password),
                          role: str(v, "role"),
                        },
                  ),
                )
                .then((result) => {
                  if (result && mode === "project") window.location.reload();
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
