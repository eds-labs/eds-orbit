"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  Building2,
  FolderKanban,
  KeyRound,
  Mail,
  Plug,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { post, put, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Input,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { DataForm, str } from "@/platform/ui/form";
import { Metric } from "@/platform/ui/metric";
import {
  InvitationList,
  OneTimeLink,
  OrganizationManager,
  type Invitation,
} from "./organization-manager";
import { at, errorText, orgRoleLabel, projectRoleLabel } from "./texts";
import { ConnectionsPanel } from "./connections-ui";
import { McpAdmin } from "./admin-mcp";
import { AiProfileEditor } from "./ai-knowledge-ui";

// The system administration (/admin, ADR 0012): installation-wide metadata
// about users, organizations, projects and invitations, and the actions on
// them. It never shows project content. The server answers 404 to anyone
// who is not an active system administrator; hiding it here is convenience.

type Page<T> = { items: T[]; nextCursor: string | null };
type UserRow = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  banned: boolean;
  createdAt: string;
  organizations: number;
  projects: number;
};

const NAV = [
  { section: "", icon: Activity, en: "Overview", de: "Übersicht" },
  { section: "integrations", icon: Plug, en: "Integrations", de: "Integrationen", connections: true },
  { section: "ai", icon: Sparkles, en: "AI & knowledge", de: "KI & Wissen", connections: true },
  { section: "mcp", icon: Plug, en: "MCP", de: "MCP" },
  { section: "users", icon: Users, en: "Users", de: "Benutzer" },
  { section: "invitations", icon: Mail, en: "Invitations", de: "Einladungen" },
  {
    section: "organizations",
    icon: Building2,
    en: "Organizations",
    de: "Organisationen",
  },
  { section: "projects", icon: FolderKanban, en: "Projects", de: "Projekte" },
  { section: "audit", icon: ShieldCheck, en: "Audit log", de: "Protokoll" },
] as const;

export const adminHref = (section = "", id?: string) =>
  ["/admin", section, id].filter(Boolean).join("/");

export function AdminArea({
  section,
  id,
  locale,
  currentUserId,
  connections = false,
}: {
  section: string;
  id?: string;
  locale: Locale;
  currentUserId: string;
  /** Central connections and AI profiles exist (ORBIT_CONNECTIONS). */
  connections?: boolean;
}) {
  const de = locale === "de";
  const nav = NAV.filter((n) => connections || !("connections" in n));
  return (
    <div className="admin-layout">
      <nav className="settings-nav" aria-label={de ? "Administration" : "Administration"}>
        <div>
          <p className="settings-nav-heading">
            {de ? "Administration" : "Administration"}
          </p>
          <ul>
            {nav.map((n) => (
              <li key={n.section}>
                <Link
                  className="settings-nav-link"
                  href={adminHref(n.section)}
                  aria-current={section === n.section ? "page" : undefined}
                >
                  {n[locale]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="admin-mobile-nav">
        <label htmlFor="admin-section">{de ? "Bereich" : "Section"}</label>
        <select
          id="admin-section"
          className="input"
          value={section}
          onChange={(e) => window.location.assign(adminHref(e.target.value))}
        >
          {nav.map((n) => (
            <option key={n.section} value={n.section}>
              {n[locale]}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-content">
        {section === "" && <Overview locale={locale} />}
        {section === "integrations" && connections && <Integrations locale={locale} />}
        {section === "mcp" && <McpAdmin locale={locale} />}
        {section === "ai" && connections && (
          <>
            <PageHead
              title={de ? "KI & Wissen" : "AI & knowledge"}
              description={
                de
                  ? "Systemweite KI-Standards. Anbieter-Schlüssel und ihre Budgets verwaltest du unter Integrationen; gemeinsames Wissen in den Organisationen."
                  : "System-wide AI defaults. Provider keys and their budgets live under Integrations; shared knowledge in the organizations."
              }
            />
            <AiProfileEditor path="/admin/ai/profile" locale={locale} scopeLabel="System" />
          </>
        )}
        {section === "users" &&
          (id ? (
            <UserDetail id={id} locale={locale} currentUserId={currentUserId} />
          ) : (
            <UserList locale={locale} />
          ))}
        {section === "invitations" && <Invitations locale={locale} />}
        {section === "organizations" &&
          (id ? (
            <>
              <BackLink href={adminHref("organizations")} locale={locale} />
              <OrganizationManager organizationId={id} locale={locale} />
            </>
          ) : (
            <Organizations locale={locale} />
          ))}
        {section === "projects" && <Projects locale={locale} />}
        {section === "audit" && <Audit locale={locale} />}
      </div>
    </div>
  );
}

function Integrations({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const orgs = useResource<Page<{ id: string; name: string }>>("/admin/organizations");
  return (
    <>
      <PageHead
        title={de ? "Integrationen" : "Integrations"}
        description={
          de
            ? "Zentrale Verbindungen wie KI-Anbieter. Infrastruktur-Geheimnisse (Datenbank, Speicher, System-E-Mail) bleiben in der Umgebung und erscheinen nur als Status in der Übersicht."
            : "Central connections such as AI providers. Infrastructure secrets (database, storage, system e-mail) stay in the environment and appear only as status on the overview."
        }
      />
      <ConnectionsPanel
        base="/admin/connections"
        mode="admin"
        locale={locale}
        targets={orgs.data?.items ?? []}
      />
    </>
  );
}

function BackLink({ href, locale }: { href: string; locale: Locale }) {
  return (
    <Link className="back-link" href={href}>
      ← {locale === "de" ? "Zurück" : "Back"}
    </Link>
  );
}

function Loaded<T>({
  resource,
  locale,
  children,
}: {
  resource: { data: T | null; error: Error | null; loading: boolean; refresh: () => void };
  locale: Locale;
  children: (data: T) => ReactNode;
}) {
  if (resource.loading && !resource.data)
    return <Loading label={locale === "de" ? "Wird geladen…" : "Loading…"} />;
  if (!resource.data)
    return <ResourceError error={resource.error} retry={resource.refresh} />;
  return <>{children(resource.data)}</>;
}

type OverviewData = {
  users: { total: number; active: number; deactivated: number; admins: number };
  organizations: number;
  projects: { total: number; paused: number };
  openInvitations: number;
  sessions: { active: number; createdLast24h: number };
  system: {
    database: string;
    worker: string;
    lastHeartbeat: string | null;
    systemMail: "configured" | "missing";
    version: string | null;
  };
};

function Overview({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const overview = useResource<OverviewData>("/admin/overview");
  return (
    <>
      <PageHead
        title={de ? "Administration" : "Administration"}
        description={
          de
            ? "Benutzer, Organisationen und Projekte dieser Orbit-Installation. Projektinhalte sind hier nicht sichtbar."
            : "Users, organizations and projects of this Orbit installation. Project content is not visible here."
        }
      />
      <Loaded resource={overview} locale={locale}>
        {(o) => (
          <>
            <div className="metrics-strip metrics-four">
              <Metric
                icon={Users}
                label={de ? "Aktive Benutzer" : "Active users"}
                amount={String(o.users.active)}
                detail={
                  de
                    ? `${o.users.deactivated} deaktiviert · ${o.users.admins} Admins`
                    : `${o.users.deactivated} deactivated · ${o.users.admins} admins`
                }
              />
              <Metric
                icon={Building2}
                label={de ? "Organisationen" : "Organizations"}
                amount={String(o.organizations)}
              />
              <Metric
                icon={FolderKanban}
                label={de ? "Projekte" : "Projects"}
                amount={String(o.projects.total)}
                detail={de ? `${o.projects.paused} pausiert` : `${o.projects.paused} paused`}
              />
              <Metric
                icon={KeyRound}
                label={de ? "Aktive Sitzungen" : "Active sessions"}
                amount={String(o.sessions.active)}
                detail={
                  de
                    ? `${o.sessions.createdLast24h} neu in 24 h · ${o.openInvitations} offene Einladungen`
                    : `${o.sessions.createdLast24h} new in 24 h · ${o.openInvitations} open invitations`
                }
              />
            </div>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{de ? "Systemstatus" : "System status"}</h2>
                  <p>
                    {de
                      ? "Zustände ohne Details; Geheimnisse werden nie angezeigt."
                      : "States only; secrets are never shown."}
                  </p>
                </div>
              </div>
              <dl className="detail-grid">
                <dt>{de ? "Datenbank" : "Database"}</dt>
                <dd>
                  <Badge tone="success">{o.system.database}</Badge>
                </dd>
                <dt>Worker</dt>
                <dd>
                  <Badge tone={o.system.worker === "ready" ? "success" : "warning"}>
                    {o.system.worker}
                  </Badge>{" "}
                  {o.system.lastHeartbeat && at(o.system.lastHeartbeat, locale)}
                </dd>
                <dt>{de ? "System-E-Mail" : "System e-mail"}</dt>
                <dd>
                  <Badge
                    tone={o.system.systemMail === "configured" ? "success" : "neutral"}
                  >
                    {o.system.systemMail === "configured"
                      ? de
                        ? "eingerichtet"
                        : "configured"
                      : de
                        ? "nicht eingerichtet: Links werden manuell weitergegeben"
                        : "not configured: links are passed on by hand"}
                  </Badge>
                </dd>
                <dt>Version</dt>
                <dd>{o.system.version ?? "—"}</dd>
              </dl>
            </section>
          </>
        )}
      </Loaded>
    </>
  );
}

function UserList({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (query.trim()) params.set("query", query.trim());
  if (status) params.set("status", status);
  if (role) params.set("role", role);
  if (cursor) params.set("cursor", cursor);
  const users = useResource<Page<UserRow>>(`/admin/users?${params}`);
  return (
    <>
      <PageHead
        title={de ? "Benutzer" : "Users"}
        description={
          de
            ? "Alle Konten der Installation mit ihren Mitgliedschaften."
            : "Every account of the installation with its memberships."
        }
      />
      <div className="admin-filters">
        <Input
          type="search"
          aria-label={de ? "Name oder E-Mail suchen" : "Search name or e-mail"}
          placeholder={de ? "Name oder E-Mail" : "Name or e-mail"}
          value={query}
          onChange={(e) => {
            setCursor(null);
            setQuery(e.target.value);
          }}
        />
        <select
          className="input"
          aria-label={de ? "Status" : "Status"}
          value={status}
          onChange={(e) => {
            setCursor(null);
            setStatus(e.target.value);
          }}
        >
          <option value="">{de ? "Alle Status" : "Any status"}</option>
          <option value="active">{de ? "Aktiv" : "Active"}</option>
          <option value="deactivated">{de ? "Deaktiviert" : "Deactivated"}</option>
        </select>
        <select
          className="input"
          aria-label={de ? "Rolle" : "Role"}
          value={role}
          onChange={(e) => {
            setCursor(null);
            setRole(e.target.value);
          }}
        >
          <option value="">{de ? "Alle Rollen" : "Any role"}</option>
          <option value="admin">{de ? "Administration" : "Administrators"}</option>
          <option value="user">{de ? "Benutzer" : "Users"}</option>
        </select>
      </div>
      <Loaded resource={users} locale={locale}>
        {(page) =>
          page.items.length ? (
            <section className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{de ? "Person" : "Person"}</th>
                      <th>{de ? "Status" : "Status"}</th>
                      <th>{de ? "Organisationen" : "Organizations"}</th>
                      <th>{de ? "Projekte" : "Projects"}</th>
                      <th>{de ? "Erstellt" : "Created"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link className="row-button" href={adminHref("users", u.id)}>
                            {u.name}
                          </Link>
                          <small>{u.email}</small>
                        </td>
                        <td>
                          <UserBadges user={u} locale={locale} />
                        </td>
                        <td>{u.organizations}</td>
                        <td>{u.projects}</td>
                        <td>{at(u.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(cursor || page.nextCursor) && (
                <div className="pager">
                  {cursor && (
                    <Button variant="outline" size="sm" onClick={() => setCursor(null)}>
                      {de ? "Zum Anfang" : "First page"}
                    </Button>
                  )}
                  {page.nextCursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCursor(page.nextCursor)}
                    >
                      {de ? "Weiter" : "Next"}
                    </Button>
                  )}
                </div>
              )}
            </section>
          ) : (
            <Empty title={de ? "Keine Benutzer gefunden." : "No users found."} />
          )
        }
      </Loaded>
    </>
  );
}

function UserBadges({
  user,
  locale,
}: {
  user: { role: string; banned: boolean };
  locale: Locale;
}) {
  const de = locale === "de";
  return (
    <span className="badge-row">
      {user.banned ? (
        <Badge tone="danger">{de ? "Deaktiviert" : "Deactivated"}</Badge>
      ) : (
        <Badge tone="success">{de ? "Aktiv" : "Active"}</Badge>
      )}
      {user.role === "admin" && <Badge tone="blue">Admin</Badge>}
    </span>
  );
}

type UserDetailData = {
  user: UserRow & { emailVerified: boolean; locale: string | null };
  activeSessions: number;
  lastActiveAt: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
  projects: Array<{
    id: string;
    name: string;
    paused: boolean;
    workspaceId: string;
    role: string;
    moduleRoles: Record<string, string>;
  }>;
  openInvitations: Array<{
    id: string;
    expiresAt: string;
    organization: { id: string; name: string };
  }>;
};

function UserDetail({
  id,
  locale,
  currentUserId,
}: {
  id: string;
  locale: Locale;
  currentUserId: string;
}) {
  const de = locale === "de";
  const detail = useResource<UserDetailData>(`/admin/users/${encodeURIComponent(id)}`);
  const action = useMutation(detail.refresh);
  const [link, setLink] = useState<string | null>(null);
  const [roleChange, setRoleChange] = useState<"admin" | "user" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = `/admin/users/${encodeURIComponent(id)}`;
  return (
    <>
      <BackLink href={adminHref("users")} locale={locale} />
      <Loaded resource={detail} locale={locale}>
        {(d) => {
          const self = d.user.id === currentUserId;
          return (
            <>
              <PageHead title={d.user.name} description={d.user.email}>
                <UserBadges user={d.user} locale={locale} />
              </PageHead>
              {action.error && (
                <Alert kind="error">{errorText(action.error, locale)}</Alert>
              )}
              {notice && <Alert kind="success">{notice}</Alert>}
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>{de ? "Konto" : "Account"}</h2>
                    <p>
                      {de
                        ? `${d.activeSessions} aktive Sitzungen · zuletzt aktiv ${at(d.lastActiveAt, locale)}`
                        : `${d.activeSessions} active sessions · last active ${at(d.lastActiveAt, locale)}`}
                    </p>
                  </div>
                </div>
                <div className="admin-actions">
                  {d.user.banned ? (
                    <Button
                      variant="outline"
                      disabled={action.pending}
                      onClick={() =>
                        void action.run(() => post(`${path}/reactivate`, {}))
                      }
                    >
                      {de ? "Reaktivieren" : "Reactivate"}
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      disabled={action.pending || self}
                      onClick={() => {
                        if (
                          window.confirm(
                            de
                              ? `${d.user.name} deaktivieren? Alle Sitzungen und App-Verbindungen enden sofort.`
                              : `Deactivate ${d.user.name}? All sessions and app connections end at once.`,
                          )
                        )
                          void action.run(() => post(`${path}/deactivate`, {}));
                      }}
                    >
                      {de ? "Deaktivieren" : "Deactivate"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={action.pending || d.activeSessions === 0}
                    onClick={async () => {
                      const r = await action.run(() =>
                        post<{ revoked: number }>(`${path}/sessions/revoke`, {}),
                      );
                      if (r)
                        setNotice(
                          de
                            ? `${r.revoked} Sitzungen beendet.`
                            : `${r.revoked} sessions ended.`,
                        );
                    }}
                  >
                    {de ? "Alle Sitzungen beenden" : "Sign out everywhere"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.pending || d.user.banned}
                    onClick={async () => {
                      const r = await action.run(() =>
                        post<{ delivery: string; link?: string }>(
                          `${path}/password-reset`,
                          {},
                        ),
                      );
                      if (r?.link) setLink(r.link);
                      else if (r)
                        setNotice(
                          de
                            ? "Ein Link zum Zurücksetzen wurde per E-Mail gesendet."
                            : "A reset link was sent by e-mail.",
                        );
                    }}
                  >
                    {de ? "Passwort zurücksetzen" : "Reset password"}
                  </Button>
                  {d.user.role === "admin" ? (
                    <Button
                      variant="outline"
                      disabled={action.pending || self}
                      onClick={() => setRoleChange("user")}
                    >
                      {de ? "Adminrolle entfernen" : "Remove administrator role"}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={action.pending || d.user.banned}
                      onClick={() => setRoleChange("admin")}
                    >
                      {de ? "Zum Admin machen" : "Make administrator"}
                    </Button>
                  )}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>{de ? "Mitgliedschaften" : "Memberships"}</h2>
                    <p>
                      {de
                        ? "Organisation → Projekt → Projektrolle → Modulrollen. Ändern in der Organisation."
                        : "Organization → project → project role → module roles. Change them in the organization."}
                    </p>
                  </div>
                </div>
                {d.organizations.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{de ? "Organisation" : "Organization"}</th>
                          <th>{de ? "Projekt" : "Project"}</th>
                          <th>{de ? "Rolle" : "Role"}</th>
                          <th>{de ? "Modulrollen" : "Module roles"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.organizations.flatMap((o) => {
                          const projects = d.projects.filter(
                            (p) => p.workspaceId === o.id,
                          );
                          const head = (
                            <tr key={o.id}>
                              <td>
                                <Link
                                  className="row-button"
                                  href={adminHref("organizations", o.id)}
                                >
                                  {o.name}
                                </Link>
                              </td>
                              <td>—</td>
                              <td>{orgRoleLabel(o.role, locale)}</td>
                              <td>—</td>
                            </tr>
                          );
                          return [
                            head,
                            ...projects.map((p) => (
                              <tr key={`${o.id}:${p.id}`}>
                                <td />
                                <td>{p.name}</td>
                                <td>{projectRoleLabel(p.role, locale)}</td>
                                <td>
                                  {Object.entries(p.moduleRoles)
                                    .map(
                                      ([m, r]) =>
                                        `${m}: ${r === "none" ? (de ? "kein Zugriff" : "no access") : projectRoleLabel(r, locale)}`,
                                    )
                                    .join(", ") || "—"}
                                </td>
                              </tr>
                            )),
                          ];
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title={de ? "Keine Mitgliedschaften." : "No memberships."}
                  />
                )}
              </section>
              {roleChange && (
                <Modal
                  title={
                    roleChange === "admin"
                      ? de
                        ? "Zum Administrator machen"
                        : "Make administrator"
                      : de
                        ? "Adminrolle entfernen"
                        : "Remove administrator role"
                  }
                  description={
                    de
                      ? "Bestätige mit deinem eigenen Passwort."
                      : "Confirm with your own password."
                  }
                  onClose={() => setRoleChange(null)}
                >
                  <DataForm
                    fields={[
                      {
                        name: "password",
                        label: de ? "Dein Passwort" : "Your password",
                        type: "password",
                        required: true,
                      },
                    ]}
                    pending={action.pending}
                    error={errorText(action.error, locale)}
                    submitLabel={de ? "Bestätigen" : "Confirm"}
                    onSubmit={async (v) => {
                      const r = await action.run(() =>
                        put(`${path}/system-role`, {
                          role: roleChange,
                          password: String(v.password),
                        }),
                      );
                      if (r) setRoleChange(null);
                    }}
                  />
                </Modal>
              )}
              {link && (
                <OneTimeLink link={link} locale={locale} onClose={() => setLink(null)} />
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}

type OrganizationRow = {
  id: string;
  name: string;
  createdAt: string;
  members: number;
  owners: number;
  projects: number;
};

function Organizations({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const [query, setQuery] = useState("");
  const list = useResource<Page<OrganizationRow>>(
    `/admin/organizations${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`,
  );
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const create = useMutation(list.refresh);
  return (
    <>
      <PageHead
        title={de ? "Organisationen" : "Organizations"}
        description={
          de
            ? "Organisationen bündeln Mitglieder und Projekte."
            : "Organizations group members and projects."
        }
      >
        <Button onClick={() => setCreating(true)}>
          {de ? "Organisation anlegen" : "Create organization"}
        </Button>
      </PageHead>
      <div className="admin-filters">
        <Input
          type="search"
          aria-label={de ? "Organisation suchen" : "Search organizations"}
          placeholder={de ? "Name" : "Name"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Loaded resource={list} locale={locale}>
        {(page) =>
          page.items.length ? (
            <section className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{de ? "Name" : "Name"}</th>
                      <th>{de ? "Mitglieder" : "Members"}</th>
                      <th>Owner</th>
                      <th>{de ? "Projekte" : "Projects"}</th>
                      <th>{de ? "Erstellt" : "Created"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link
                            className="row-button"
                            href={adminHref("organizations", o.id)}
                          >
                            {o.name}
                          </Link>
                        </td>
                        <td>{o.members}</td>
                        <td>
                          {o.owners ? (
                            o.owners
                          ) : (
                            <Badge tone="warning">
                              {de ? "Kein Owner" : "No owner"}
                            </Badge>
                          )}
                        </td>
                        <td>{o.projects}</td>
                        <td>{at(o.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <Empty
              title={de ? "Keine Organisationen gefunden." : "No organizations found."}
            />
          )
        }
      </Loaded>
      {creating && (
        <Modal
          title={de ? "Organisation anlegen" : "Create organization"}
          description={
            de
              ? "Ein bestehendes Konto wird sofort Owner; sonst erhält die Adresse eine Owner-Einladung."
              : "An existing account becomes owner at once; otherwise the address receives an owner invitation."
          }
          onClose={() => setCreating(false)}
        >
          <DataForm
            fields={[
              { name: "name", label: "Name", required: true },
              {
                name: "ownerEmail",
                label: de ? "E-Mail des Owners" : "Owner's e-mail",
                type: "email",
                required: true,
              },
            ]}
            pending={create.pending}
            error={errorText(create.error, locale)}
            submitLabel={de ? "Anlegen" : "Create"}
            onSubmit={async (v) => {
              const r = await create.run(() =>
                post<{ invitation: { link?: string } | null }>(
                  "/admin/organizations",
                  { name: str(v, "name"), ownerEmail: str(v, "ownerEmail") },
                ),
              );
              if (r) {
                setCreating(false);
                if (r.invitation?.link) setLink(r.invitation.link);
              }
            }}
          />
        </Modal>
      )}
      {link && (
        <OneTimeLink link={link} locale={locale} onClose={() => setLink(null)} />
      )}
    </>
  );
}

type ProjectRow = {
  id: string;
  name: string;
  paused: boolean;
  createdAt: string;
  members: number;
  workspace: { id: string; name: string };
};

function Projects({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (query.trim()) params.set("query", query.trim());
  if (cursor) params.set("cursor", cursor);
  const list = useResource<Page<ProjectRow>>(`/admin/projects?${params}`);
  return (
    <>
      <PageHead
        title={de ? "Projekte" : "Projects"}
        description={
          de
            ? "Alle Projekte aller Organisationen, nur Metadaten."
            : "Every project of every organization, metadata only."
        }
      />
      <div className="admin-filters">
        <Input
          type="search"
          aria-label={de ? "Projekt suchen" : "Search projects"}
          placeholder={de ? "Name" : "Name"}
          value={query}
          onChange={(e) => {
            setCursor(null);
            setQuery(e.target.value);
          }}
        />
      </div>
      <Loaded resource={list} locale={locale}>
        {(page) =>
          page.items.length ? (
            <section className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{de ? "Projekt" : "Project"}</th>
                      <th>{de ? "Organisation" : "Organization"}</th>
                      <th>{de ? "Mitglieder" : "Members"}</th>
                      <th>{de ? "Status" : "Status"}</th>
                      <th>{de ? "Erstellt" : "Created"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>
                          <Link
                            className="row-button"
                            href={adminHref("organizations", p.workspace.id)}
                          >
                            {p.workspace.name}
                          </Link>
                        </td>
                        <td>{p.members}</td>
                        <td>
                          {p.paused ? (
                            <Badge tone="warning">{de ? "Pausiert" : "Paused"}</Badge>
                          ) : (
                            <Badge tone="success">{de ? "Aktiv" : "Active"}</Badge>
                          )}
                        </td>
                        <td>{at(p.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.nextCursor && (
                <div className="pager">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCursor(page.nextCursor)}
                  >
                    {de ? "Weiter" : "Next"}
                  </Button>
                </div>
              )}
            </section>
          ) : (
            <Empty title={de ? "Keine Projekte gefunden." : "No projects found."} />
          )
        }
      </Loaded>
    </>
  );
}

function Invitations({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const list = useResource<{ items: Invitation[] }>("/admin/invitations");
  const [link, setLink] = useState<string | null>(null);
  return (
    <>
      <PageHead
        title={de ? "Einladungen" : "Invitations"}
        description={
          de
            ? "Offene Einladungen aller Organisationen. Neue Einladungen entstehen in der Organisation."
            : "Open invitations of every organization. New invitations are made in the organization."
        }
      />
      <Loaded resource={list} locale={locale}>
        {(data) => (
          <InvitationList
            invitations={data.items}
            base={(i) => `/organizations/${encodeURIComponent(i.organization.id)}`}
            locale={locale}
            onChange={list.refresh}
            onLink={(r) => r?.link && setLink(r.link)}
            showOrganization
          />
        )}
      </Loaded>
      {link && (
        <OneTimeLink link={link} locale={locale} onClose={() => setLink(null)} />
      )}
    </>
  );
}

type AuditRow = {
  id: string;
  actorId: string;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

function Audit({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useResource<Page<AuditRow>>(
    `/admin/audit${cursor ? `?cursor=${cursor}` : ""}`,
  );
  return (
    <>
      <PageHead
        title={de ? "Protokoll" : "Audit log"}
        description={
          de
            ? "Administrative Änderungen, ohne Inhalte, Adressen oder Passwörter."
            : "Administrative changes, without content, addresses or passwords."
        }
      />
      <Loaded resource={list} locale={locale}>
        {(page) =>
          page.items.length ? (
            <section className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{de ? "Zeit" : "Time"}</th>
                      <th>{de ? "Aktion" : "Action"}</th>
                      <th>{de ? "Von" : "By"}</th>
                      <th>{de ? "Ziel" : "Target"}</th>
                      <th>{de ? "Details" : "Details"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((a) => (
                      <tr key={a.id}>
                        <td>{at(a.createdAt, locale)}</td>
                        <td>
                          <code>{a.action}</code>
                        </td>
                        <td>{a.actorName ?? a.actorId}</td>
                        <td>
                          {a.targetName ?? a.targetId}
                          <small>{a.targetType}</small>
                        </td>
                        <td>
                          <small>
                            {Object.entries(a.metadata)
                              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : String(v)}`)
                              .join(" · ") || "—"}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.nextCursor && (
                <div className="pager">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCursor(page.nextCursor)}
                  >
                    {de ? "Ältere" : "Older"}
                  </Button>
                </div>
              )}
            </section>
          ) : (
            <Empty title={de ? "Noch keine Einträge." : "No entries yet."} />
          )
        }
      </Loaded>
    </>
  );
}
