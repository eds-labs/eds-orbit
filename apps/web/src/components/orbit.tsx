"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Home,
  Target,
  FileText,
  Images,
  CalendarDays,
  BookOpen,
  CircleCheck,
  ChartNoAxesColumn,
  Brain,
  Link2,
  Activity,
  Settings,
  Menu,
  X,
  Plus,
  LogOut,
  MoreHorizontal,
  MessageCircle,
  ArrowUpRight,
} from "lucide-react";
import {
  api,
  post,
  useMutation,
  useResource,
  type Identity,
  type Project,
} from "@/lib/api";
import { labels, type Locale, type Text } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Alert, Button, Loading, Modal, Badge } from "./ui/primitives";
import { DataForm, str, type FormField, type FormValues } from "./form";
import { WorkspaceContext } from "./workspace-context";
import {
  Overview,
  Missions,
  ContentStudio,
  ApprovalInbox,
  CalendarView,
} from "./work";
import { Knowledge } from "./knowledge";
import { OrbitChat } from "./chat";
import { BrandAssetLibrary } from "./advanced";
import {
  Analytics,
  Memory,
  Connectors,
  Operations,
  ProjectSettings,
} from "./management";
const navigation = [
  { key: "overview", path: "/", icon: Home },
  { key: "missions", path: "/missions", icon: Target },
  { key: "chat", path: "/chat", icon: MessageCircle },
  { key: "content", path: "/content", icon: FileText },
  { key: "calendar", path: "/calendar", icon: CalendarDays },
  { key: "knowledge", path: "/knowledge", icon: BookOpen },
  { key: "assets", path: "/assets", icon: Images },
  { key: "approvals", path: "/approvals", icon: CircleCheck },
  { key: "analytics", path: "/analytics", icon: ChartNoAxesColumn },
  { key: "memory", path: "/memory", icon: Brain },
  { key: "connectors", path: "/connectors", icon: Link2 },
  { key: "operations", path: "/operations", icon: Activity },
  { key: "settings", path: "/settings", icon: Settings },
] as const;
export function Orbit() {
  const pathname = usePathname();
  const [locale, setLocale] = useState<Locale>("en"),
    [projectId, setProjectId] = useState(""),
    [menu, setMenu] = useState(false),
    [newProject, setNewProject] = useState(false),
    [revision, setRevision] = useState(0);
  const setup = useResource<{ configured: boolean }>("/setup");
  const identity = useResource<Identity>(setup.data?.configured ? "/me" : null);
  const t: Text = (key) => labels[locale][key];
  const mutation = useMutation(() => {
    setNewProject(false);
    identity.refresh();
  });
  const signout = useMutation(identity.refresh);
  useEffect(() => {
    const lang = localStorage.getItem("orbit.locale");
    if (lang === "de" || lang === "en") setLocale(lang);
    setProjectId(localStorage.getItem("orbit.project") || "");
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("orbit.locale", locale);
  }, [locale]);
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled]),select",
        ) || [],
      );
    focusable()[0]?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(false);
        return;
      }
      if (e.key === "Tab") {
        const nodes = focusable();
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", handle);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [menu]);
  const nav = navigation.find((n) => n.path === pathname) || navigation[0];
  const project =
    identity.data?.projects.find((p) => p.id === projectId) ||
    identity.data?.projects[0];
  function changeProject(id: string) {
    setProjectId(id);
    localStorage.setItem("orbit.project", id);
    setRevision((n) => n + 1);
  }
  async function createProject(v: FormValues) {
    const result = await mutation.run(() =>
      post<Project>("/projects", {
        name: str(v, "name"),
        timezone: str(v, "timezone"),
        language: str(v, "language"),
      }),
    );
    if (result) changeProject(result.id);
  }
  if (setup.loading || (setup.data?.configured && identity.loading))
    return (
      <div className="boot">
        <Brand />
        <Loading label={t("loading")} />
      </div>
    );
  if (setup.error)
    return (
      <div className="boot">
        <Brand />
        <Alert kind="error">{setup.error.message}</Alert>
        <Button onClick={setup.refresh}>{t("retry")}</Button>
      </div>
    );
  if (
    !setup.data?.configured ||
    identity.error?.status === 401 ||
    (!identity.data && !identity.error)
  )
    return (
      <Authentication
        setup={!setup.data?.configured}
        locale={locale}
        setLocale={setLocale}
        onDone={() => {
          setup.refresh();
          identity.refresh();
        }}
      />
    );
  if (identity.error || !identity.data)
    return (
      <div className="boot">
        <Alert kind="error">
          {identity.error?.message || "Unable to load your identity."}
        </Alert>
        <Button onClick={identity.refresh}>{t("retry")}</Button>
      </div>
    );
  const role =
    project?.role ||
    identity.data.workspaces.find((w) => w.id === project?.workspaceId)?.role ||
    "viewer";
  const isOwner = role === "owner",
    canEdit = role !== "viewer";
  const content = !project ? (
    <div className="onboarding">
      <h1>
        {locale === "de" ? "Dein erster Orbit." : "Create your first project."}
      </h1>
      <p>
        {locale === "de"
          ? "Ein eigener Bereich für Marke, Wissen und Inhalte."
          : "A separate home for your brand, knowledge and content."}
      </p>
      <DataForm
        fields={projectFields(t)}
        onSubmit={createProject}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel={t("newProject")}
        t={t}
      />
    </div>
  ) : (
    <WorkspaceContext.Provider
      value={{
        project,
        identity: identity.data,
        locale,
        t,
        canEdit,
        isOwner,
        revision,
        refresh: () => setRevision((n) => n + 1),
      }}
    >
      <div key={`${project.id}:${nav.key}`}>
        {!canEdit && <Alert>{t("viewer")}</Alert>}
        {nav.key === "overview" ? (
          <Overview />
        ) : nav.key === "missions" ? (
          <Missions />
        ) : nav.key === "chat" ? (
          <OrbitChat />
        ) : nav.key === "content" ? (
          <ContentStudio />
        ) : nav.key === "calendar" ? (
          <CalendarView />
        ) : nav.key === "knowledge" ? (
          <Knowledge />
        ) : nav.key === "assets" ? (
          <BrandAssetLibrary />
        ) : nav.key === "approvals" ? (
          <ApprovalInbox />
        ) : nav.key === "analytics" ? (
          <Analytics />
        ) : nav.key === "memory" ? (
          <Memory />
        ) : nav.key === "connectors" ? (
          <Connectors />
        ) : nav.key === "operations" ? (
          <Operations />
        ) : (
          <ProjectSettings />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
  return (
    <div className="orbit">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {menu && (
        <button
          className="nav-scrim"
          aria-label={t("close")}
          onClick={() => setMenu(false)}
        />
      )}
      <aside
        className={cn("sidebar", menu && "sidebar-open")}
        role={menu ? "dialog" : undefined}
        aria-modal={menu || undefined}
        aria-label={menu ? "Workspace navigation" : undefined}
      >
        <div className="brand-row">
          <Brand />
          <Button
            className="mobile-only"
            size="icon"
            variant="ghost"
            aria-label={t("close")}
            onClick={() => setMenu(false)}
          >
            <X />
          </Button>
        </div>
        <div className="project-control">
          <label className="sr-only" htmlFor="project">
            {t("project")}
          </label>
          <select
            id="project"
            value={project?.id || ""}
            onChange={(e) => changeProject(e.target.value)}
          >
            {!identity.data.projects.length && (
              <option value="">{t("newProject")}</option>
            )}
            {identity.data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("newProject")}
            disabled={!identity.data.workspaces.some((w) => w.role === "owner")}
            onClick={() => setNewProject(true)}
          >
            <Plus />
          </Button>
        </div>
        <nav aria-label="Workspace">
          {navigation.map((item) => (
            <Link
              key={item.key}
              href={item.path}
              className={cn("nav-link", item.key === nav.key && "nav-active")}
              aria-current={item.key === nav.key ? "page" : undefined}
            >
              <item.icon aria-hidden="true" />
              <span>{t(item.key)}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p>
            A self-hosted
            <br />
            marketing workspace.
          </p>
          <span>
            EDS Orbit <span className="version">0.1 RC</span>
          </span>
          <button
            className="signout"
            disabled={signout.pending}
            onClick={() => signout.run(() => post("/auth/sign-out", {}))}
          >
            <LogOut />
            {t("signOut")}
          </button>
        </div>
      </aside>
      <div className="workspace" inert={menu || undefined}>
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <Button
            className="mobile-only"
            variant="ghost"
            size="icon"
            aria-label={t("menu")}
            onClick={() => setMenu(true)}
          >
            <Menu />
          </Button>
          <div className="breadcrumb">
            <span>{project?.name || "EDS Orbit"}</span>
            <span>/</span>
            <strong>{t(nav.key)}</strong>
          </div>
          <div className="topbar-actions">
            <div className="language-control" aria-label="Interface language">
              <button
                lang="en"
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en")}
              >
                EN
              </button>
              <button
                lang="de"
                aria-pressed={locale === "de"}
                onClick={() => setLocale("de")}
              >
                DE
              </button>
            </div>
            <span
              className="avatar"
              title={`${identity.data.user.name} · ${role}`}
            >
              {identity.data.user.name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <div className="mobile-project">
          <label htmlFor="mobile-project-select">{t("project")}</label>
          <select
            id="mobile-project-select"
            value={project?.id || ""}
            onChange={(event) => changeProject(event.target.value)}
          >
            {identity.data.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <main id="main" className="main">
          {signout.error && <Alert kind="error">{signout.error}</Alert>}
          {content}
          <footer className="page-footer">
            <span>{t("protected")}</span>
            <span>EDS Orbit · RC</span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace">
        {[navigation[0], navigation[2], navigation[3], navigation[5]].map(
          (n) => (
            <Link
              key={n.key}
              href={n.path}
              aria-current={nav.key === n.key ? "page" : undefined}
            >
              <n.icon />
              <span>
                {n.key === "content"
                  ? locale === "de"
                    ? "Inhalte"
                    : "Content"
                  : t(n.key)}
              </span>
            </Link>
          ),
        )}
        <button onClick={() => setMenu(true)}>
          <MoreHorizontal />
          <span>{locale === "de" ? "Mehr" : "More"}</span>
        </button>
      </nav>
      {newProject && (
        <Modal title={t("newProject")} onClose={() => setNewProject(false)}>
          <DataForm
            fields={projectFields(t)}
            onSubmit={createProject}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={t("create")}
            onCancel={() => setNewProject(false)}
            t={t}
          />
        </Modal>
      )}
    </div>
  );
}
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="EDS Orbit home">
      <Image
        src="/brand/logo-layer-stack-mark.svg"
        alt=""
        width={36}
        height={36}
        priority
      />
      <span>EDS Orbit</span>
    </Link>
  );
}
function projectFields(t: Text): FormField[] {
  return [
    { name: "name", label: t("name"), required: true },
    {
      name: "timezone",
      label: t("timezone"),
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
      required: true,
    },
    {
      name: "language",
      label: t("language"),
      type: "select",
      value: "en",
      options: [
        { value: "en", label: "English" },
        { value: "de", label: "Deutsch" },
      ],
      required: true,
    },
  ];
}
function Authentication({
  setup,
  locale,
  setLocale,
  onDone,
}: {
  setup: boolean;
  locale: Locale;
  setLocale: (l: Locale) => void;
  onDone: () => void;
}) {
  const t: Text = (k) => labels[locale][k];
  const mutation = useMutation(onDone);
  const de = locale === "de";
  const fields: FormField[] = [
    ...(setup
      ? [
          {
            name: "name",
            label: de ? "Dein Name" : "Your name",
            required: true,
          },
          {
            name: "workspaceName",
            label: de ? "Workspace-Name" : "Workspace name",
            required: true,
          },
        ]
      : []),
    { name: "email", label: "Email", type: "email", required: true },
    {
      name: "password",
      label: de ? "Passwort" : "Password",
      type: "password",
      required: true,
      hint: setup
        ? de
          ? "Mindestens 12 Zeichen."
          : "At least 12 characters."
        : undefined,
    },
    ...(setup
      ? [
          {
            name: "setupToken",
            label: de ? "Installationstoken" : "Installation token",
            type: "password" as const,
            required: true,
            hint: de
              ? "Aus der lokalen Orbit-Installation. Wird nicht gespeichert."
              : "From your local Orbit installation. Never stored in your browser.",
          },
        ]
      : []),
  ];
  return (
    <div className="auth-page">
      <header>
        <Brand />
        <button
          className="text-button"
          onClick={() => setLocale(de ? "en" : "de")}
        >
          {de ? "English" : "Deutsch"}
        </button>
      </header>
      <div className="auth-layout">
        <section className="auth-intro">
          <h1>
            {de
              ? "Gute Arbeit beginnt mit gutem Wissen."
              : "Good work starts with good knowledge."}
          </h1>
          <p>
            {de
              ? "Dein Marketing-Workspace. Eigene Infrastruktur. Nachvollziehbare Entscheidungen."
              : "Your marketing workspace. Your infrastructure. Decisions you can trace."}
          </p>
          <div className="auth-principles">
            <span>
              <BookOpen />{" "}
              {de ? "Belege vor Behauptungen" : "Evidence before claims"}
            </span>
            <span>
              <CircleCheck />{" "}
              {de ? "Du definierst die Grenzen" : "You define the boundaries"}
            </span>
            <span>
              <ArrowUpRight />{" "}
              {de ? "Vom Ziel zum Ergebnis" : "From objective to outcome"}
            </span>
          </div>
        </section>
        <section className="auth-card">
          <Badge tone="blue">
            {setup
              ? de
                ? "Neue Installation"
                : "New installation"
              : "EDS Orbit"}
          </Badge>
          <h2>
            {setup
              ? de
                ? "Richte deinen Workspace ein"
                : "Set up your workspace"
              : de
                ? "Willkommen zurück"
                : "Welcome back"}
          </h2>
          <p>
            {setup
              ? de
                ? "Du wirst Owner. Externe Aktionen bleiben im Beobachtungsmodus gesperrt."
                : "You will be the owner. External actions remain off in Observe mode."
              : de
                ? "Melde dich an, um dein Projekt fortzusetzen."
                : "Sign in to continue your work."}
          </p>
          <DataForm
            fields={fields}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={
              setup
                ? de
                  ? "Workspace erstellen"
                  : "Create workspace"
                : de
                  ? "Anmelden"
                  : "Sign in"
            }
            t={t}
            onSubmit={(v) =>
              mutation
                .run(async () => {
                  if (setup)
                    await post("/setup", {
                      name: str(v, "name"),
                      workspaceName: str(v, "workspaceName"),
                      email: str(v, "email"),
                      password: String(v.password),
                      setupToken: String(v.setupToken),
                    });
                  await post("/auth/sign-in/email", {
                    email: str(v, "email"),
                    password: String(v.password),
                  });
                })
                .then(() => {})
            }
          />
        </section>
      </div>
      <footer>
        {de
          ? "Selbst gehostet. Daten bleiben in deinem Workspace."
          : "Self-hosted. Your workspace, under your control."}
      </footer>
    </div>
  );
}
