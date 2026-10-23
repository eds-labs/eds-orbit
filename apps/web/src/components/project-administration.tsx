"use client";
// Project administration and members (WP2.3b, platform UI); two settings
// sections since the UI restructure (§5.4).
import { useState } from "react";
import { KeyRound, Settings, Trash2, UserPlus } from "lucide-react";
import {
  action,
  collectionPath,
  put,
  remove,
  useMutation,
  useResource,
} from "@/lib/api";
import { Alert, Badge, Button, Modal, Loading } from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { ModuleRoles } from "./module-roles";
import { PublicKeys } from "./public-keys";
import {
  InvitationList,
  OneTimeLink,
  type Invitation,
  type InvitationResult,
} from "@/platform/administration/organization-manager";
import { errorText, projectRoleLabel } from "@/platform/administration/texts";
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
 * list, inviting someone (ADR 0012: they set their own password), each
 * member's project and module roles, removal and open invitations.
 */
export function ProjectMembers() {
  const { project, isOwner, locale, identity, refresh } = useWorkspace();
  const de = locale === "de";
  const administration = Boolean(identity.administration);
  const members = useResource<{ items: Array<Record<string, unknown>> }>(
    isOwner ? collectionPath(project.id, "members") : null,
  );
  const invitations = useResource<{ items: Invitation[] }>(
    isOwner && administration
      ? collectionPath(project.id, "invitations")
      : null,
  );
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [rolesFor, setRolesFor] = useState<{
    userId: string;
    name: string;
    projectRole: string;
  } | null>(null);
  const reload = () => {
    refresh();
    members.refresh();
    invitations.refresh();
  };
  const mutation = useMutation(reload);
  const change = useMutation(reload);
  if (!isOwner) return null;
  const memberPath = (userId: string) =>
    collectionPath(project.id, `members/${encodeURIComponent(userId)}`);
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <h2>{de ? "Mitglieder & Rollen" : "Members & roles"}</h2>
        <div className="page-actions">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus data-icon="inline-start" />
            {de ? "Mitglied einladen" : "Invite member"}
          </Button>
        </div>
      </div>
      <ResourceError error={members.error} retry={members.refresh} />
      {change.error && (
        <Alert kind="error">{errorText(change.error, locale)}</Alert>
      )}
      {members.loading ? (
        <Loading />
      ) : members.data?.items.length ? (
        <div className="member-list">
          {members.data.items.map((m, i) => {
            const user = m.user as Record<string, unknown> | undefined;
            const userId = String(m.userId);
            const name = String(user?.name || m.name || "Member");
            return (
              <div className="member-row" key={String(m.id || i)}>
                <div>
                  <strong>{name}</strong>
                  <small>{String(user?.email || m.email || "")}</small>
                </div>
                <div className="page-actions">
                  {administration ? (
                    <select
                      className="input input-compact"
                      aria-label={`${de ? "Projektrolle von" : "Project role of"} ${name}`}
                      value={String(m.role)}
                      disabled={change.pending}
                      onChange={(e) =>
                        void change.run(() =>
                          put(memberPath(userId), { role: e.target.value }),
                        )
                      }
                    >
                      {(["viewer", "editor", "owner"] as const).map((r) => (
                        <option key={r} value={r}>
                          {projectRoleLabel(r, locale)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge>{String(m.role || "member")}</Badge>
                  )}
                  {m.role !== "owner" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setRolesFor({ userId, name, projectRole: String(m.role) })
                      }
                    >
                      {de ? "Modulrollen" : "Module roles"}
                    </Button>
                  )}
                  {administration && userId !== identity.user.id && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${de ? "Aus dem Projekt entfernen:" : "Remove from project:"} ${name}`}
                      disabled={change.pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            de
                              ? `${name} aus dem Projekt entfernen?`
                              : `Remove ${name} from the project?`,
                          )
                        )
                          void change.run(() => remove(memberPath(userId)));
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="panel-note">
          {de ? "Keine weiteren Mitglieder." : "No additional members."}
        </p>
      )}
      {administration && invitations.data && invitations.data.items.length > 0 && (
        <InvitationList
          invitations={invitations.data.items}
          base={collectionPath(project.id, "").replace(/\/$/, "")}
          locale={locale}
          onChange={reload}
          onLink={(r) => r?.link && setLink(r.link)}
        />
      )}
      {rolesFor && (
        <ModuleRoles {...rolesFor} onClose={() => setRolesFor(null)} />
      )}
      {adding && (
        <Modal
          title={de ? "Mitglied einladen" : "Invite member"}
          description={
            de
              ? "Mitglieder der Organisation erhalten den Zugriff sofort. Alle anderen bekommen einen Einladungslink und legen ihr Passwort selbst fest."
              : "Members of the organization get access at once. Everyone else receives an invitation link and sets their own password."
          }
          onClose={() => setAdding(false)}
        >
          <DataForm
            fields={[
              {
                name: "email",
                label: "E-Mail",
                type: "email",
                required: true,
              },
              {
                name: "role",
                label: de ? "Projektrolle" : "Project role",
                type: "select",
                value: "viewer",
                options: [
                  {
                    value: "viewer",
                    label: de ? "Lesen · nur ansehen" : "Viewer · read only",
                  },
                  {
                    value: "editor",
                    label: de
                      ? "Bearbeiten · Inhalte und Prüfung"
                      : "Editor · content and review",
                  },
                  {
                    value: "owner",
                    label: de
                      ? "Owner · volle Projektrechte"
                      : "Owner · full project authority",
                  },
                ],
              },
              {
                name: "locale",
                label: de ? "Sprache der Einladung" : "Invitation language",
                type: "select",
                value: locale,
                options: [
                  { value: "en", label: "English" },
                  { value: "de", label: "Deutsch" },
                ],
              },
            ]}
            pending={mutation.pending}
            error={errorText(mutation.error, locale)}
            onCancel={() => setAdding(false)}
            submitLabel={de ? "Einladen" : "Invite"}
            onSubmit={async (v) => {
              const result = await mutation.run(() =>
                action<InvitationResult>(project.id, "add-member", {
                  email: str(v, "email"),
                  role: str(v, "role"),
                  locale: str(v, "locale"),
                }),
              );
              if (result) {
                setAdding(false);
                if (result.delivery === "link" && result.link)
                  setLink(result.link);
              }
            }}
          />
        </Modal>
      )}
      {link && (
        <OneTimeLink link={link} locale={locale} onClose={() => setLink(null)} />
      )}
    </section>
  );
}
