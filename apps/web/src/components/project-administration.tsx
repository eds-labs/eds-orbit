"use client";
// Project administration and members (WP2.3b, platform UI); two settings
// sections since the UI restructure (§5.4).
import { useState } from "react";
import { KeyRound, Settings, UserPlus } from "lucide-react";
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
import { PublicKeys } from "./public-keys";
/**
 * The owner's project actions (settings section "project"): edit the
 * project and manage its public client keys.
 */
export function ProjectAdministration() {
  const { project, isOwner, t, refresh } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    setEditing(false);
  });
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <h2>Project access</h2>
        <div className="page-actions">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Settings data-icon="inline-start" />
            Edit project
          </Button>
          <Button variant="outline" size="sm" onClick={() => setKeysOpen(true)}>
            <KeyRound data-icon="inline-start" />
            Public keys
          </Button>
        </div>
      </div>
      {keysOpen && <PublicKeys onClose={() => setKeysOpen(false)} />}
      {editing && (
        <Modal title="Edit project" onClose={() => setEditing(false)}>
          <DataForm
            fields={[
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
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={() => setEditing(false)}
            submitLabel={t("save")}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "project-settings", {
                    name: str(v, "name"),
                    timezone: str(v, "timezone"),
                    language: str(v, "language"),
                  }),
                )
                .then((result) => {
                  if (result) window.location.reload();
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}

/**
 * The project's members (settings section "members", owners only): the
 * list, adding a local member and each member's module roles.
 */
export function ProjectMembers() {
  const { project, isOwner, locale, t, refresh } = useWorkspace();
  const members = useResource<{ items: Array<Record<string, unknown>> }>(
    isOwner ? collectionPath(project.id, "members") : null,
  );
  const [adding, setAdding] = useState(false);
  const [rolesFor, setRolesFor] = useState<{
    userId: string;
    name: string;
    projectRole: string;
  } | null>(null);
  const mutation = useMutation(() => {
    refresh();
    members.refresh();
    setAdding(false);
  });
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <h2>{locale === "de" ? "Mitglieder & Rollen" : "Members & roles"}</h2>
        <div className="page-actions">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
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
      {adding && (
        <Modal
          title="Add local member"
          description="Creates a local identity and project membership. No email is sent. Share credentials through your own approved secure process."
          onClose={() => setAdding(false)}
        >
          <DataForm
            fields={[
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
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={() => setAdding(false)}
            submitLabel={t("save")}
            onSubmit={(v) =>
              mutation.run(() =>
                action(project.id, "add-member", {
                  name: str(v, "name"),
                  email: str(v, "email"),
                  password: String(v.password),
                  role: str(v, "role"),
                }),
              )
            }
          />
        </Modal>
      )}
    </section>
  );
}
