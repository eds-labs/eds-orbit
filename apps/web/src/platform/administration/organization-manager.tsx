"use client";
import { useState } from "react";
import { Copy, Mail, Trash2, UserPlus } from "lucide-react";
import {
  patch,
  post,
  put,
  remove,
  useMutation,
  useResource,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { ResourceError } from "@/platform/ui/collection";
import { at, errorText, orgRoleLabel, projectRoleLabel } from "./texts";

// One organization's members, their project and module roles, and its
// invitations (ADR 0012). The organization settings (/o/:id/settings) and
// the system administration show the same view; the API decides what the
// caller may change.

export type OrganizationDetail = {
  organization: { id: string; name: string; createdAt: string };
  members: Array<{
    id: string;
    name: string;
    email: string;
    banned: boolean;
    role: "owner" | "member";
  }>;
  projects: Array<{
    id: string;
    name: string;
    paused: boolean;
    members: Array<{
      userId: string;
      role: string;
      moduleRoles: Record<string, string>;
    }>;
  }>;
  invitations: Invitation[];
  modules: Array<{ id: string; name: { en: string; de: string } }>;
};
export type Invitation = {
  id: string;
  email: string;
  role: "owner" | "member";
  expiresAt: string;
  expired: boolean;
  organization: { id: string; name: string };
  projects: Array<{ id: string; name: string; role: string }>;
};
/** What creating or resending an invitation answers. */
export type InvitationResult = {
  status?: "invited" | "added";
  delivery?: "email" | "link";
  link?: string;
};

/** Shows a link once, for an inviter without system mail. */
export function OneTimeLink({
  link,
  locale,
  onClose,
}: {
  link: string;
  locale: Locale;
  onClose: () => void;
}) {
  const de = locale === "de";
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title={de ? "Link weitergeben" : "Pass on the link"}
      description={
        de
          ? "Es wurde keine E-Mail versendet. Gib diesen Link persönlich weiter; er wird nur jetzt angezeigt und funktioniert einmal."
          : "No e-mail was sent. Pass this link on personally; it is shown only now and works once."
      }
      onClose={onClose}
    >
      <div className="one-time-link">
        <code>{link}</code>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            navigator.clipboard
              ?.writeText(link)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          <Copy />
          {copied ? (de ? "Kopiert" : "Copied") : de ? "Kopieren" : "Copy"}
        </Button>
      </div>
    </Modal>
  );
}

const roles = ["none", "viewer", "editor", "owner"] as const;

export function OrganizationManager({
  organizationId,
  locale,
}: {
  organizationId: string;
  locale: Locale;
}) {
  const de = locale === "de";
  const base = `/organizations/${encodeURIComponent(organizationId)}`;
  const detail = useResource<OrganizationDetail>(base);
  const change = useMutation(detail.refresh);
  const [inviting, setInviting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [moduleCell, setModuleCell] = useState<{
    projectId: string;
    userId: string;
  } | null>(null);
  if (detail.loading && !detail.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!detail.data)
    return <ResourceError error={detail.error} retry={detail.refresh} />;
  const d = detail.data;
  const owners = new Set(
    d.members.filter((m) => m.role === "owner").map((m) => m.id),
  );
  const cell = (projectId: string, userId: string) =>
    d.projects
      .find((p) => p.id === projectId)
      ?.members.find((m) => m.userId === userId);
  const setProjectRole = (projectId: string, userId: string, role: string) =>
    change.run(() =>
      role === "none"
        ? remove(`${base}/projects/${projectId}/members/${userId}`)
        : put(`${base}/projects/${projectId}/members/${userId}`, { role }),
    );
  const showLink = (result: InvitationResult | undefined) => {
    if (result?.delivery === "link" && result.link) setLink(result.link);
  };
  const editing = moduleCell && cell(moduleCell.projectId, moduleCell.userId);
  return (
    <div className="admin-stack">
      {change.error && (
        <Alert kind="error">{errorText(change.error, locale)}</Alert>
      )}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{d.organization.name}</h2>
            <p>
              {de
                ? `${d.members.length} Mitglieder · ${d.projects.length} Projekte`
                : `${d.members.length} members · ${d.projects.length} projects`}
            </p>
          </div>
          <div className="panel-actions">
            <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
              {de ? "Umbenennen" : "Rename"}
            </Button>
            <Button size="sm" onClick={() => setInviting(true)}>
              <UserPlus />
              {de ? "Einladen" : "Invite"}
            </Button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{de ? "Person" : "Person"}</th>
                <th>{de ? "Organisationsrolle" : "Organization role"}</th>
                {d.projects.map((p) => (
                  <th key={p.id}>{p.name}</th>
                ))}
                <th>
                  <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    <small>{m.email}</small>
                    {m.banned && (
                      <Badge tone="danger">
                        {de ? "Deaktiviert" : "Deactivated"}
                      </Badge>
                    )}
                  </td>
                  <td>
                    <select
                      className="input input-compact"
                      aria-label={`${de ? "Organisationsrolle von" : "Organization role of"} ${m.name}`}
                      value={m.role}
                      disabled={change.pending}
                      onChange={(e) =>
                        change.run(() =>
                          put(`${base}/members/${m.id}`, {
                            role: e.target.value,
                          }),
                        )
                      }
                    >
                      <option value="owner">{orgRoleLabel("owner", locale)}</option>
                      <option value="member">
                        {orgRoleLabel("member", locale)}
                      </option>
                    </select>
                  </td>
                  {d.projects.map((p) => {
                    const membership = cell(p.id, m.id);
                    const overrides = Object.keys(
                      membership?.moduleRoles ?? {},
                    ).length;
                    return (
                      <td key={p.id}>
                        {owners.has(m.id) ? (
                          <Badge tone="blue">Owner</Badge>
                        ) : (
                          <div className="matrix-cell">
                            <select
                              className="input input-compact"
                              aria-label={`${p.name}: ${m.name}`}
                              value={membership?.role ?? "none"}
                              disabled={change.pending}
                              onChange={(e) =>
                                setProjectRole(p.id, m.id, e.target.value)
                              }
                            >
                              {roles.map((r) => (
                                <option key={r} value={r}>
                                  {r === "none"
                                    ? de
                                      ? "Kein Zugriff"
                                      : "No access"
                                    : projectRoleLabel(r, locale)}
                                </option>
                              ))}
                            </select>
                            {membership &&
                              membership.role !== "owner" &&
                              d.modules.length > 0 && (
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    setModuleCell({
                                      projectId: p.id,
                                      userId: m.id,
                                    })
                                  }
                                >
                                  {overrides
                                    ? de
                                      ? `${overrides} Modulrollen`
                                      : `${overrides} module roles`
                                    : de
                                      ? "Modulrollen"
                                      : "Module roles"}
                                </button>
                              )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${de ? "Aus Organisation entfernen:" : "Remove from organization:"} ${m.name}`}
                      disabled={change.pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            de
                              ? `${m.name} aus der Organisation und allen ihren Projekten entfernen?`
                              : `Remove ${m.name} from the organization and all its projects?`,
                          )
                        )
                          void change.run(() => remove(`${base}/members/${m.id}`));
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <InvitationList
        invitations={d.invitations}
        base={base}
        locale={locale}
        onChange={detail.refresh}
        onLink={showLink}
      />
      {inviting && (
        <InviteDialog
          base={base}
          projects={d.projects}
          locale={locale}
          onClose={() => setInviting(false)}
          onDone={(result) => {
            setInviting(false);
            detail.refresh();
            showLink(result);
          }}
        />
      )}
      {renaming && (
        <Modal
          title={de ? "Organisation umbenennen" : "Rename organization"}
          onClose={() => setRenaming(false)}
        >
          <DataForm
            fields={[
              {
                name: "name",
                label: de ? "Name" : "Name",
                required: true,
                value: d.organization.name,
              },
            ]}
            pending={change.pending}
            error={errorText(change.error, locale)}
            submitLabel={de ? "Speichern" : "Save"}
            onSubmit={async (v) => {
              const done = await change.run(() =>
                patch(base, { name: str(v, "name") }),
              );
              if (done) setRenaming(false);
            }}
          />
        </Modal>
      )}
      {moduleCell && editing && (
        <ModuleRolesDialog
          title={`${d.members.find((m) => m.id === moduleCell.userId)?.name} · ${d.projects.find((p) => p.id === moduleCell.projectId)?.name}`}
          modules={d.modules}
          current={editing.moduleRoles}
          locale={locale}
          onClose={() => setModuleCell(null)}
          onSave={async (moduleRoles) => {
            const done = await change.run(() =>
              put(
                `${base}/projects/${moduleCell.projectId}/members/${moduleCell.userId}`,
                { role: editing.role, moduleRoles },
              ),
            );
            if (done !== undefined) setModuleCell(null);
          }}
          pending={change.pending}
        />
      )}
      {link && (
        <OneTimeLink link={link} locale={locale} onClose={() => setLink(null)} />
      )}
    </div>
  );
}

function ModuleRolesDialog({
  title,
  modules,
  current,
  locale,
  onClose,
  onSave,
  pending,
}: {
  title: string;
  modules: OrganizationDetail["modules"];
  current: Record<string, string>;
  locale: Locale;
  onClose: () => void;
  onSave: (roles: Record<string, string | null>) => void;
  pending: boolean;
}) {
  const de = locale === "de";
  const [roles, setRoles] = useState<Record<string, string>>(current);
  return (
    <Modal
      title={de ? "Modulrollen" : "Module roles"}
      description={title}
      onClose={onClose}
    >
      <div className="module-role-list">
        {modules.map((m) => (
          <label key={m.id} className="module-role-row">
            <span>{m.name[locale]}</span>
            <select
              className="input input-compact"
              value={roles[m.id] ?? ""}
              onChange={(e) => setRoles({ ...roles, [m.id]: e.target.value })}
            >
              <option value="">
                {de ? "Wie Projektrolle" : "Same as project role"}
              </option>
              <option value="editor">{projectRoleLabel("editor", locale)}</option>
              <option value="viewer">{projectRoleLabel("viewer", locale)}</option>
              <option value="none">{de ? "Kein Zugriff" : "No access"}</option>
            </select>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <Button variant="outline" onClick={onClose}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            onSave(
              Object.fromEntries(
                modules.map((m) => [m.id, roles[m.id] ? roles[m.id]! : null]),
              ),
            )
          }
        >
          {de ? "Speichern" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}

export function InvitationList({
  invitations,
  base,
  locale,
  onChange,
  onLink,
  showOrganization = false,
}: {
  invitations: Invitation[];
  /** The organization's API path; per row when listing several. */
  base: string | ((i: Invitation) => string);
  locale: Locale;
  onChange: () => void;
  onLink: (result: InvitationResult | undefined) => void;
  showOrganization?: boolean;
}) {
  const de = locale === "de";
  const mutation = useMutation(onChange);
  const path = (i: Invitation) =>
    `${typeof base === "string" ? base : base(i)}/invitations/${i.id}`;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{de ? "Offene Einladungen" : "Open invitations"}</h2>
          <p>
            {de
              ? "Links gelten sieben Tage und funktionieren einmal."
              : "Links are valid for seven days and work once."}
          </p>
        </div>
      </div>
      {mutation.error && (
        <Alert kind="error">{errorText(mutation.error, locale)}</Alert>
      )}
      {invitations.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{de ? "Adresse" : "Address"}</th>
                {showOrganization && <th>{de ? "Organisation" : "Organization"}</th>}
                <th>{de ? "Zugriff" : "Access"}</th>
                <th>{de ? "Gültig bis" : "Valid until"}</th>
                <th>
                  <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  {showOrganization && <td>{i.organization.name}</td>}
                  <td>
                    {orgRoleLabel(i.role, locale)}
                    {i.projects.map((p) => (
                      <small key={p.id}>
                        {p.name}: {projectRoleLabel(p.role, locale)}
                      </small>
                    ))}
                  </td>
                  <td>
                    {i.expired ? (
                      <Badge tone="warning">{de ? "Abgelaufen" : "Expired"}</Badge>
                    ) : (
                      at(i.expiresAt, locale)
                    )}
                  </td>
                  <td className="row-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={mutation.pending}
                      onClick={async () =>
                        onLink(
                          await mutation.run(() =>
                            post<InvitationResult>(`${path(i)}/resend`, {}),
                          ),
                        )
                      }
                    >
                      <Mail />
                      {de ? "Neu senden" : "Resend"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={mutation.pending}
                      onClick={() => void mutation.run(() => remove(path(i)))}
                    >
                      {de ? "Zurückziehen" : "Revoke"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={de ? "Keine offenen Einladungen." : "No open invitations."} />
      )}
    </section>
  );
}

export function InviteDialog({
  base,
  projects,
  locale,
  onClose,
  onDone,
}: {
  base: string;
  projects: Array<{ id: string; name: string }>;
  locale: Locale;
  onClose: () => void;
  onDone: (result: InvitationResult | undefined) => void;
}) {
  const de = locale === "de";
  const mutation = useMutation();
  const [grants, setGrants] = useState<Record<string, string>>({});
  return (
    <Modal
      title={de ? "Person einladen" : "Invite someone"}
      description={
        de
          ? "Die Person erhält einen Link und legt ihr Passwort selbst fest. Bestehende Mitglieder erhalten den Zugriff sofort."
          : "They receive a link and set their own password. Existing members get the access at once."
      }
      onClose={onClose}
      wide
    >
      {projects.length > 0 && (
        <fieldset className="grant-list">
          <legend>{de ? "Projektzugriff" : "Project access"}</legend>
          {projects.map((p) => (
            <label key={p.id} className="module-role-row">
              <span>{p.name}</span>
              <select
                className="input input-compact"
                value={grants[p.id] ?? "none"}
                onChange={(e) => setGrants({ ...grants, [p.id]: e.target.value })}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r === "none"
                      ? de
                        ? "Kein Zugriff"
                        : "No access"
                      : projectRoleLabel(r, locale)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      <DataForm
        fields={[
          { name: "email", label: "E-Mail", type: "email", required: true },
          {
            name: "role",
            label: de ? "Organisationsrolle" : "Organization role",
            type: "select",
            value: "member",
            options: [
              { value: "member", label: orgRoleLabel("member", locale) },
              { value: "owner", label: orgRoleLabel("owner", locale) },
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
        submitLabel={de ? "Einladen" : "Invite"}
        onCancel={onClose}
        onSubmit={async (v) => {
          const result = await mutation.run(() =>
            post<InvitationResult>(`${base}/invitations`, {
              email: str(v, "email"),
              role: str(v, "role"),
              locale: str(v, "locale"),
              projects: Object.entries(grants)
                .filter(([, role]) => role !== "none")
                .map(([projectId, role]) => ({ projectId, role })),
            }),
          );
          if (result) onDone(result);
        }}
      />
    </Modal>
  );
}
