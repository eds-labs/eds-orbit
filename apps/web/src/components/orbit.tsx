"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  CircleCheck,
  Menu,
  X,
  Plus,
  LogOut,
  MoreHorizontal,
  ArrowUpRight,
} from "lucide-react";
import {
  post,
  useMutation,
  useResource,
  type Identity,
  type Project,
} from "@/lib/api";
import { labels, type Locale, type Text } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Alert, Button, Loading, Modal, Badge } from "./ui/primitives";
import {
  DataForm,
  str,
  type FormField,
  type FormValues,
} from "@/platform/ui/form";
import { WorkspaceContext } from "./workspace-context";
import { NotificationBell } from "./notification-bell";
import {
  activeNavKey,
  crumbs,
  pageTitle,
  knownModuleStates,
  waitsForModuleStates,
  type SettledModuleStates,
  moduleShown,
  defaultProject,
  navGroupOf,
  homeSections,
  keptSuffix,
  locate,
  navOrder,
  pickerHref,
  projectHref,
  routeEnabled,
  rewriteLegacyHref,
  routeTable,
  type Route,
} from "@/platform/shell/routes";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { StandaloneContext } from "@/platform/shell/standalone-context";
import {
  buildNavGroups,
  withSettingsLinks,
  mobileCurrentKey,
  mobileEntries,
} from "@/platform/shell/nav-groups";
import {
  readCollapsed,
  revealGroup,
  toggleCollapsed,
  writeCollapsed,
} from "@/platform/shell/nav-collapse";
import { NavBadge, SidebarNav } from "@/platform/shell/sidebar-nav";
import { moduleSettingsSection } from "@/platform/shell/settings-nav";
import {
  attentionRenderers,
  clearAttentionCache,
  navBadges,
  overflowBadge,
  useAttentionLoad,
} from "@/platform/shell/attention";
import { signedQuery, signIn } from "@/platform/connect/oauth-flow";
import type { WebRegistry } from "@/platform/shell/types";
import { NotFound } from "@/platform/shell/not-found";
import {
  OrganizationPicker,
  ProjectPicker,
  projectFields,
} from "@/platform/shell/pickers";

const LAST_PROJECT = "orbit.project";
type ModuleStates = {
  modules: Array<{ id: string; enabled: boolean; access?: string }>;
};

const lastProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};

/**
 * The web shell (WP1.7): sign-in, organization and project pickers, and the
 * project pages from the route registry the composition root passes in. The
 * shell imports no module; it learns them from `registry`.
 */
export function Orbit({ registry }: { registry: WebRegistry }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const table = useMemo(() => routeTable(registry), [registry]);
  const place = locate(pathname, table);
  const [locale, setLocale] = useState<Locale>("en"),
    [localeLoaded, setLocaleLoaded] = useState(false),
    [menu, setMenu] = useState(false),
    [newProject, setNewProject] = useState(false),
    [createdProject, setCreatedProject] = useState(""),
    [revision, setRevision] = useState(0),
    [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set()),
    [collapsedLoaded, setCollapsedLoaded] = useState(false);
  const setup = useResource<{ configured: boolean }>("/setup");
  const identity = useResource<Identity>(setup.data?.configured ? "/me" : null);
  const t: Text = (key) => labels[locale][key];
  const mutation = useMutation(() => {
    setNewProject(false);
    identity.refresh();
  });
  const signout = useMutation(identity.refresh);
  const projectId =
    place.kind === "view" || place.kind === "notFound"
      ? place.projectId
      : undefined;
  const project = projectId
    ? identity.data?.projects.find((p) => p.id === projectId)
    : undefined;
  // Refetched with the workspace revision, so a module switch shows at once.
  const moduleStates = useResource<ModuleStates>(
    project
      ? `/projects/${encodeURIComponent(project.id)}/modules?revision=${revision}`
      : null,
  );
  // The last settled load per project (null states: it failed), kept while a
  // refresh refetches them.
  const [lastStates, setLastStates] =
    useState<SettledModuleStates<ModuleStates> | null>(null);
  useEffect(() => {
    if (!project) return;
    if (moduleStates.data)
      setLastStates({ projectId: project.id, states: moduleStates.data });
    else if (moduleStates.error)
      // A failure after a success keeps the states that loaded.
      setLastStates((last) =>
        last?.projectId === project.id && last.states
          ? last
          : { projectId: project.id, states: null },
      );
  }, [project?.id, moduleStates.data, moduleStates.error]);
  const knownStates = knownModuleStates(
    moduleStates.data,
    lastStates,
    project?.id,
  );
  // Shared by the sidebar badges and the home page (§4.4), through a 30 s
  // cache that outlives the remount on navigation (ruling R15).
  const attention = useAttentionLoad(
    identity.data?.user.id,
    project?.id,
    revision,
    pathname,
  );
  // Responses are filtered for the member: none survives a signed-out state.
  const signedOut =
    identity.error?.status === 401 ||
    (!identity.loading && !identity.data && !identity.error);
  useEffect(() => {
    if (signedOut) clearAttentionCache();
  }, [signedOut]);
  const renderers = useMemo(() => attentionRenderers(registry), [registry]);
  useEffect(() => {
    try {
      const lang = localStorage.getItem("orbit.locale");
      if (lang === "de" || lang === "en") setLocale(lang);
    } catch {
      /* Defaults apply without storage. */
    }
    setLocaleLoaded(true);
    // After mount like the locale, so the server markup matches.
    setCollapsed(readCollapsed());
    setCollapsedLoaded(true);
  }, []);
  // Navigating opens the page's sidebar group; not before the stored groups
  // are read, and not on a click, so the open page's group can collapse.
  useEffect(() => {
    if (!collapsedLoaded || place.kind !== "view") return;
    const key = activeNavKey(place.route);
    const entry = table.routes.find((r) => r.key === key) ?? place.route;
    const next = revealGroup(collapsed, navGroupOf(entry));
    if (next === collapsed) return;
    setCollapsed(next);
    writeCollapsed(next);
    // `place` is derived from the pathname; `collapsed` must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, collapsedLoaded, table]);
  useEffect(() => {
    document.documentElement.lang = locale;
    // Not before the stored choice is read, or the default would replace it.
    if (!localeLoaded) return;
    try {
      localStorage.setItem("orbit.locale", locale);
    } catch {
      /* Defaults apply without storage. */
    }
  }, [locale, localeLoaded]);
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(LAST_PROJECT, project.id);
    } catch {
      /* The start page then falls back to the pickers. */
    }
  }, [project]);
  // Start page, legacy paths and module roots lead to a project page.
  useEffect(() => {
    const me = identity.data;
    if (!me) return;
    if (place.kind === "redirect")
      router.replace(projectHref(place.projectId, place.route));
    if (place.kind !== "start" && place.kind !== "legacy") return;
    const id = defaultProject(me, lastProject());
    const home = table.routes.find((r) => !r.segments.length)!;
    router.replace(
      !id
        ? pickerHref(me)
        : place.kind === "start"
          ? projectHref(id, home)
          : projectHref(id, place.route) +
            keptSuffix(window.location.search, window.location.hash),
    );
    // `place` is derived from the pathname.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.data, pathname, table]);
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
  const base = useMemo((): Omit<ShellContextValue, "attention"> | null => {
    if (!project) return null;
    const states = knownStates?.modules;
    // Until the states load, or if they fail, every module counts as enabled.
    // A module the member has no access to (WP4.5) is hidden like a disabled one.
    const enabled = (id: string) =>
      moduleShown(
        states,
        id,
        registry.modules.find((m) => m.id === id)?.optIn === true,
      );
    const nav = navOrder(table.routes.filter((r) => r.nav));
    const active = registry.modules.filter((m) => enabled(m.id));
    return {
      table,
      platformNav: nav.filter((r) => !r.moduleId && routeEnabled(r, enabled)),
      modules: registry.modules.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        groupOrder: m.groupOrder,
        enabled: enabled(m.id),
        nav: nav.filter((r) => r.moduleId === m.id),
        settingsSection: moduleSettingsSection(m.id, m.settings ?? []),
      })),
      homeSections: homeSections(registry.modules, enabled),
      hrefOf: (key) => {
        const route = table.routes.find((r) => r.key === key);
        return route ? projectHref(project.id, route) : "/";
      },
      // Contributions of enabled modules only (WP2.4).
      chat: active.flatMap((m) => (m.chat ? [m.chat] : [])),
      actionRequests: Object.assign(
        {},
        ...active.map((m) => m.actionRequests ?? {}),
      ),
      attentionRenderers: renderers,
      // Each module's sections join its group of the settings list (§5.4).
      settings: active.flatMap((m) =>
        (m.settings ?? []).map((section) => ({
          ...section,
          tab: { ...section.tab, group: section.tab.group ?? m.id },
        })),
      ),
      setupLinks: active.flatMap((m) => m.setupLinks ?? []),
      connectors: {
        providers: active.flatMap((m) => m.connectors?.providers ?? []),
        extras: active.flatMap((m) => m.connectors?.extras ?? []),
      },
    };
  }, [project, knownStates, registry, table, renderers]);
  // Apart, so a loaded attention keeps the functions above unchanged.
  const shell = useMemo(
    (): ShellContextValue | null => base && { ...base, attention },
    [base, attention],
  );
  // The label of a sidebar group, for the breadcrumb and the document title.
  const groupLabel = (group: string) =>
    group === "top"
      ? undefined
      : group === "project"
        ? t("navProject")
        : registry.modules.find((m) => m.id === group)?.displayName[locale];
  useEffect(() => {
    const page =
      place.kind === "organizations"
        ? t("chooseOrganization")
        : place.kind === "organization"
          ? t("chooseProject")
          : projectId && !project
            ? t("projectNotFound")
            : place.kind === "view"
              ? pageTitle(place.route, table, locale, groupLabel)
              : place.kind === "standalone"
                ? place.view.title[locale]
                : place.kind === "notFound"
                  ? t("notFound")
                  : null;
    document.title = [page, project?.name, "EDS Orbit"]
      .filter(Boolean)
      .join(" · ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, project?.name, locale]);
  async function createProject(v: FormValues, workspaceId?: string) {
    const result = await mutation.run(() =>
      post<Project>("/projects", {
        name: str(v, "name"),
        timezone: str(v, "timezone"),
        language: str(v, "language"),
        ...(workspaceId ? { workspaceId } : {}),
      }),
    );
    if (result) {
      setCreatedProject(result.id);
      router.push(`/p/${encodeURIComponent(result.id)}`);
    }
  }
  const languageControl = (
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
  );
  const standalone = place.kind === "standalone" ? place.view : null;
  // Pages that must work whatever the state of the session, such as the error
  // page an OAuth client's refused request ends at.
  if (standalone?.session === "none")
    return (
      <StandaloneContext.Provider value={{ locale, t, identity: null }}>
        <div className="picker-page">
          <header>
            <Brand />
            <div className="topbar-actions">{languageControl}</div>
          </header>
          <main id="main" className="picker-main">
            <standalone.component />
          </main>
        </div>
      </StandaloneContext.Provider>
    );
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
        oauthLogin={Boolean(standalone?.oauthLogin)}
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
  const me = identity.data;
  const signoutButton = (
    <button
      className="signout"
      disabled={signout.pending}
      onClick={() =>
        signout.run(async () => {
          await post("/auth/sign-out", {});
          clearAttentionCache();
        })
      }
    >
      <LogOut />
      {t("signOut")}
    </button>
  );
  // Pages outside a project: pickers and unknown addresses.
  const frame = (children: ReactNode) => (
    <div className="picker-page">
      <header>
        <Brand />
        <div className="topbar-actions">
          {languageControl}
          {signoutButton}
        </div>
      </header>
      <main id="main" className="picker-main">
        {signout.error && <Alert kind="error">{signout.error}</Alert>}
        {children}
      </main>
    </div>
  );
  if (standalone)
    return frame(
      <StandaloneContext.Provider value={{ locale, t, identity: me }}>
        <standalone.component />
      </StandaloneContext.Provider>,
    );
  if (
    place.kind === "start" ||
    place.kind === "legacy" ||
    place.kind === "redirect" ||
    (projectId && !project && projectId === createdProject)
  )
    return (
      <div className="boot">
        <Brand />
        <Loading label={t("loading")} />
      </div>
    );
  if (place.kind === "organizations")
    return frame(<OrganizationPicker identity={me} t={t} />);
  if (place.kind === "organization")
    return frame(
      <ProjectPicker
        identity={me}
        organizationId={place.organizationId}
        t={t}
        create={{
          onSubmit: createProject,
          pending: mutation.pending,
          error: mutation.error,
        }}
      />,
    );
  if (!project || !shell)
    return frame(<NotFound t={t} project={Boolean(projectId)} />);
  const route: Route | null = place.kind === "view" ? place.route : null;
  const role =
    project.role ||
    me.workspaces.find((w) => w.id === project.workspaceId)?.role ||
    "viewer";
  const isOwner = role === "owner",
    canEdit = role !== "viewer";
  const organization = me.workspaces.find((w) => w.id === project.workspaceId);
  // A page of a module, or a platform page that needs one (WP2.4).
  const isOn = (id: string) =>
    Boolean(shell.modules.find((m) => m.id === id)?.enabled);
  const moduleOff = Boolean(route && !routeEnabled(route, isOn));
  const navGroups = withSettingsLinks(
    buildNavGroups(table.routes, shell.modules),
    shell.modules,
    shell.hrefOf("settings"),
  );
  const mobileBar = mobileEntries(table.routes, isOn);
  const mobileCurrent = mobileCurrentKey(mobileBar, route);
  // No badges while loading or after a failed load; navigation still works.
  const badges = navBadges(attention);
  const moreBadge = overflowBadge(
    badges,
    navGroups.flatMap((g) => g.entries.map((r) => r.key)),
    mobileBar.map((r) => r.key),
  );
  function toggleGroup(id: string) {
    const next = toggleCollapsed(collapsed, id);
    setCollapsed(next);
    writeCollapsed(next);
  }
  const homeHref = shell.hrefOf("home");
  function changeProject(id: string) {
    router.push(
      projectHref(id, route ?? table.routes.find((r) => !r.segments.length)!),
    );
  }
  const multipleOrganizations = me.workspaces.length > 1;
  const projectOptions = (prefix: string) =>
    multipleOrganizations
      ? me.workspaces.map((w) => (
          <optgroup key={`${prefix}${w.id}`} label={w.name}>
            {me.projects
              .filter((p) => p.workspaceId === w.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        ))
      : me.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ));
  const label = (r: Route) => r.nav?.label[locale] ?? r.key;
  return (
    <ShellContext.Provider value={shell}>
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
              value={project.id}
              onChange={(e) => changeProject(e.target.value)}
            >
              {projectOptions("")}
            </select>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("newProject")}
              disabled={!me.workspaces.some((w) => w.role === "owner")}
              onClick={() => setNewProject(true)}
            >
              <Plus />
            </Button>
          </div>
          <Link
            className="organization-link"
            href={
              multipleOrganizations
                ? "/o"
                : `/o/${encodeURIComponent(project.workspaceId)}`
            }
          >
            {multipleOrganizations
              ? `${organization?.name ?? t("organization")} · ${t("switchOrganization")}`
              : t("projects")}
          </Link>
          <SidebarNav
            groups={navGroups}
            activeKey={activeNavKey(route)}
            hrefOf={(r) => projectHref(project.id, r)}
            badges={badges.counts}
            urgent={badges.urgent}
            locale={locale}
            collapsed={collapsed}
            onToggle={toggleGroup}
          />
          <div className="sidebar-footer">
            <p>
              A self-hosted
              <br />
              marketing workspace.
            </p>
            <span>
              EDS Orbit <span className="version">0.1 RC</span>
            </span>
            {signoutButton}
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
              {multipleOrganizations && organization && (
                <>
                  <span>{organization.name}</span>
                  <span>/</span>
                </>
              )}
              <span>{project.name}</span>
              <span>/</span>
              {route ? (
                crumbs(route, table, locale, groupLabel).map((part, i, all) =>
                  i < all.length - 1 ? (
                    <span key={i}>
                      {part}
                      <span aria-hidden="true"> / </span>
                    </span>
                  ) : (
                    <strong key={i}>{part}</strong>
                  ),
                )
              ) : (
                <strong>{t("notFound")}</strong>
              )}
            </div>
            <div className="topbar-actions">
              <NotificationBell project={project} locale={locale} />
              {languageControl}
              <span className="avatar" title={`${me.user.name} · ${role}`}>
                {me.user.name.slice(0, 1).toUpperCase()}
              </span>
            </div>
          </header>
          <div className="mobile-project">
            <label htmlFor="mobile-project-select">{t("project")}</label>
            <select
              id="mobile-project-select"
              value={project.id}
              onChange={(event) => changeProject(event.target.value)}
            >
              {projectOptions("mobile-")}
            </select>
          </div>
          <main id="main" className="main">
            {signout.error && <Alert kind="error">{signout.error}</Alert>}
            <WorkspaceContext.Provider
              value={{
                project,
                identity: me,
                locale,
                t,
                canEdit,
                isOwner,
                revision,
                refresh: () => setRevision((n) => n + 1),
                href: (path) => rewriteLegacyHref(table, project.id, path),
              }}
            >
              {/* Remounts when modules switch: module sections bring hooks. */}
              <div
                key={`${project.id}:${route?.key ?? "not-found"}:${shell.modules
                  .filter((m) => m.enabled)
                  .map((m) => m.id)
                  .join(",")}`}
              >
                {!canEdit && route && <Alert>{t("viewer")}</Alert>}
                {!route ? (
                  <NotFound t={t} homeHref={homeHref} />
                ) : waitsForModuleStates(
                    moduleStates.data,
                    moduleStates.error,
                    lastStates,
                    project.id,
                  ) ? (
                  // The page waits for the project's first module states (a
                  // failed load renders with the defaults), so it mounts once:
                  // no "module off" flash and no remount for an opt-in module.
                  <Loading label={t("loading")} />
                ) : moduleOff ? (
                  <ModuleOff t={t} homeHref={homeHref} />
                ) : (
                  <route.component />
                )}
              </div>
            </WorkspaceContext.Provider>
            <footer className="page-footer">
              <span>{t("protected")}</span>
              <span>EDS Orbit · RC</span>
            </footer>
          </main>
        </div>
        <nav className="mobile-nav" aria-label="Mobile workspace">
          {mobileBar.map((n) => {
            const Icon = n.nav!.icon;
            const mobile = n.nav!.mobile!;
            return (
              <Link
                key={n.key}
                href={projectHref(project.id, n)}
                aria-current={n.key === mobileCurrent ? "page" : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{mobile === true ? label(n) : mobile[locale]}</span>
                <NavBadge
                  count={badges.counts[n.key] ?? 0}
                  urgent={badges.urgent.has(n.key)}
                  locale={locale}
                />
              </Link>
            );
          })}
          <button onClick={() => setMenu(true)}>
            <MoreHorizontal />
            <span>{t("more")}</span>
            <NavBadge
              count={moreBadge.count}
              urgent={moreBadge.urgent}
              locale={locale}
            />
          </button>
        </nav>
        {newProject && (
          <Modal title={t("newProject")} onClose={() => setNewProject(false)}>
            <DataForm
              fields={projectFields(t)}
              onSubmit={(v) => createProject(v)}
              pending={mutation.pending}
              error={mutation.error}
              submitLabel={t("create")}
              onCancel={() => setNewProject(false)}
              t={t}
            />
          </Modal>
        )}
      </div>
    </ShellContext.Provider>
  );
}
function ModuleOff({ t, homeHref }: { t: Text; homeHref: string }) {
  return (
    <Alert kind="warning">
      <strong>{t("moduleOff")}</strong>
      <p>{t("moduleOffHint")}</p>
      <Link className="text-link" href={homeHref}>
        {t("backHome")}
      </Link>
    </Alert>
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
function Authentication({
  setup,
  oauthLogin,
  locale,
  setLocale,
  onDone,
}: {
  setup: boolean;
  /** Signing in continues the OAuth authorization in the page URL. */
  oauthLogin: boolean;
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
                  await signIn({
                    post,
                    navigate: (url) => window.location.assign(url),
                    email: str(v, "email"),
                    password: String(v.password),
                    oauthQuery: oauthLogin
                      ? signedQuery(window.location.search)
                      : null,
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
