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
import { translate, type Locale, type Text } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Alert, Button, Loading, Modal, Badge } from "./ui/primitives";
import {
  DataForm,
  str,
  type FormField,
  type FormValues,
} from "@/platform/ui/form";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "./workspace-context";
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
  projectAwareHref,
  routeTable,
  navigationForFeatures,
  routesForFeatures,
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
import { useScrollTopOnNavigate } from "@/platform/shell/scroll-reset";
import {
  moduleSettingsSection,
  settingsSectionHref,
} from "@/platform/shell/settings-nav";
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
import { UserMenu } from "@/platform/shell/user-menu";
import { AdminArea } from "@/platform/administration/admin-area";
import { OrganizationManager } from "@/platform/administration/organization-manager";
import { OrganizationIntegrations } from "@/platform/administration/organization-integrations";
import {
  OrganizationPicker,
  ProjectPicker,
  projectFields,
} from "@/platform/shell/pickers";
import { agentPaths } from "@/platform/agents/api";
import { agentPlatformVisible } from "@/platform/agents/logic";
import { drivePaths, type DriveStatus } from "@/platform/drive/api";
import { driveFeature, type DriveFeature } from "@/platform/drive/feature";
import { OrganizationAgents } from "@/platform/agents/org-agents";
import { AssistantProvider } from "@/platform/assistant/assistant-provider";
import type { AssistantLinks } from "@/platform/assistant/links";
import {
  centerState,
  manageTitleKey,
  useManagementCapabilities,
} from "@/platform/settings-center/capabilities";
import { ScopeView } from "@/platform/settings-center/scope-view";

const LAST_PROJECT = "orbit.project";
type ModuleStates = {
  features?: Record<string, boolean>;
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
  const setup = useResource<{ configured: boolean; passwordReset?: boolean }>(
    "/setup",
  );
  const identity = useResource<Identity>(setup.data?.configured ? "/me" : null);
  const t: Text = (key) => translate(locale, key);
  const mutation = useMutation(() => {
    setNewProject(false);
    identity.refresh();
  });
  const signout = useMutation(identity.refresh);
  // The settings center (/manage) exists only while /me reports its flag in
  // preview or on; otherwise its addresses behave as before (not found).
  const settingsCenter = identity.data?.settingsCenter;
  const manage =
    place.kind === "manage" &&
    (settingsCenter === "preview" || settingsCenter === "on")
      ? place.target
      : null;
  const projectId =
    place.kind === "view" || place.kind === "notFound"
      ? place.projectId
      : manage?.scope?.kind === "project"
        ? manage.scope.projectId
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
  const caps = useManagementCapabilities(manage !== null);
  const center =
    place.kind === "manage"
      ? centerState({
          stage: settingsCenter,
          target: place.target,
          caps: caps.data,
          loading: caps.loading,
          error: caps.error,
          lastProjectId: lastProject(),
        })
      : null;
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
  // The agents entry (ADR 0021, WP1.8): owners and editors only, and only
  // while the agents API answers (it is 404 with ORBIT_AGENT_PLATFORM off).
  const memberRole = project
    ? project.role ||
      identity.data?.workspaces.find((w) => w.id === project.workspaceId)
        ?.role ||
      "viewer"
    : undefined;
  const agentsProbe = useResource<unknown>(
    project && (memberRole === "owner" || memberRole === "editor")
      ? agentPaths.templates(project.id)
      : null,
  );
  const agentPlatform = agentPlatformVisible(memberRole, agentsProbe);
  // The Google Drive page (design 2026-11-05 §5.2): listed while the project
  // has a Drive folder. The status is read from Orbit, not from Google.
  // It reloads with the workspace revision, like the module states.
  const driveStatus = useResource<DriveStatus>(
    project ? `${drivePaths(project.id).status}?revision=${revision}` : null,
  );
  const [driveKnown, setDriveKnown] = useState<DriveFeature>(null);
  const drive = project
    ? driveFeature(driveKnown, project.id, driveStatus.data)
    : null;
  // Kept in state so a reload keeps it (render-time update, converges at once).
  if (drive?.projectId !== driveKnown?.projectId || drive?.enabled !== driveKnown?.enabled)
    setDriveKnown(drive);
  const googleDrive = drive?.enabled === true;
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
  // Card links of the personal assistant open in the card's project (WP3.8).
  const projectsOfMember = identity.data?.projects;
  const assistantLinks = useMemo(
    (): AssistantLinks => ({
      hrefFor: (id, href) => projectAwareHref(table, id, href),
      projectName: (id) => projectsOfMember?.find((p) => p.id === id)?.name,
    }),
    [table, projectsOfMember],
  );
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
  // A language saved in the account (ADR 0013) wins over this browser's.
  const accountLocale = identity.data?.user.locale;
  useEffect(() => {
    if (localeLoaded && (accountLocale === "de" || accountLocale === "en"))
      setLocale(accountLocale);
  }, [localeLoaded, accountLocale]);
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
  useScrollTopOnNavigate(pathname);
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
  // A bare /manage leads to the scope `centerState` picks.
  const centerRedirect = center?.kind === "redirect" ? center.href : null;
  useEffect(() => {
    if (centerRedirect) router.replace(centerRedirect);
  }, [centerRedirect, router]);
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
    // So is one whose `minAccess` the member's access does not reach.
    const enabled = (id: string) => {
      const module = registry.modules.find((m) => m.id === id);
      return moduleShown(states, id, module?.optIn === true, module?.minAccess);
    };
    const features = { ...knownStates?.features, agentPlatform, googleDrive };
    const nav = navOrder(navigationForFeatures(table.routes, features));
    const active = registry.modules.filter((m) => enabled(m.id));
    return {
      features,
      table: {
        ...table,
        routes: routesForFeatures(table.routes, features),
      },
      platformNav: nav.filter((r) => !r.moduleId && routeEnabled(r, enabled)),
      modules: registry.modules.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        groupOrder: m.groupOrder,
        enabled: enabled(m.id),
        access: states?.find((state) => state.id === m.id)?.access,
        nav: nav.filter((r) => r.moduleId === m.id),
        settingsSection: moduleSettingsSection(m.id, m.settings ?? []),
      })),
      homeSections: homeSections(registry.modules, enabled),
      hrefOf: (key) => {
        const route = table.routes.find((r) => r.key === key);
        return route ? projectHref(project.id, route) : "/";
      },
      // Contributions of enabled modules only (WP2.4).
      chat: active.flatMap((m) =>
        m.chat
          ? [
              {
                ...m.chat,
                access: states?.find((state) => state.id === m.id)?.access,
              },
            ]
          : [],
      ),
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
      drive: {
        fileActions: active.flatMap((m) => m.drive?.fileActions ?? []),
        toolbar: active.flatMap((m) => m.drive?.toolbar ?? []),
      },
      agentSetups: Object.assign({}, ...active.map((m) => m.agentSetups ?? {})),
    };
  }, [project, knownStates, registry, table, renderers, agentPlatform, googleDrive]);
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
  const manageTitle = manageTitleKey(place.kind === "manage", settingsCenter);
  useEffect(() => {
    const page = manageTitle
      ? t(manageTitle)
      : place.kind === "organizations"
        ? t("chooseOrganization")
        : place.kind === "organizationAgents"
          ? locale === "de"
            ? "Agenten"
            : "Agents"
          : place.kind === "organization"
            ? t("chooseProject")
            : projectId && !project
              ? t("projectNotFound")
              : place.kind === "view"
                ? pageTitle(
                    base?.table.routes.find((r) => r.key === place.route.key) ??
                      place.route,
                    base?.table ?? table,
                    locale,
                    groupLabel,
                  )
                : place.kind === "standalone"
                  ? place.view.title[locale]
                  : place.kind === "notFound"
                    ? t("notFound")
                    : null;
    document.title = [page, project?.name, "EDS Orbit"]
      .filter(Boolean)
      .join(" · ");
    // `manageTitle` too: a directly loaded /manage page learns the stage only
    // when /me arrives; it is null on every other place, so it never changes
    // there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, project?.name, locale, knownStates, manageTitle]);
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
      router.push(result.setupPath ?? `/p/${encodeURIComponent(result.id)}`);
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
      <StandaloneContext.Provider
        value={{ locale, t, identity: null, setLocale }}
      >
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
        passwordReset={Boolean(setup.data?.passwordReset)}
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
  const userMenu = (organizationId?: string, role?: string) => (
    <UserMenu
      identity={me}
      organizationId={organizationId}
      role={role}
      t={t}
      signingOut={signout.pending}
      onSignOut={() =>
        signout.run(async () => {
          await post("/auth/sign-out", {});
          clearAttentionCache();
        })
      }
    />
  );
  // The personal assistant (ADR 0022, WP3.8) around every authenticated page:
  // the same element at the root of the project shell and of `frame`, so its
  // state and a running reply survive navigation between them, and outside
  // the keyed workspace <div>, so they survive project switches. Its
  // organization: the open project's or organization's, else the last
  // project's, else the server's default.
  const assistantWorkspace =
    project?.workspaceId ??
    ("organizationId" in place ? place.organizationId : undefined) ??
    me.projects.find((p) => p.id === lastProject())?.workspaceId;
  const withAssistant = (tree: ReactNode, aboveNav = false) => (
    <AssistantProvider
      identity={me}
      locale={locale}
      pathname={pathname}
      routeProjectId={project?.id}
      workspaceId={assistantWorkspace}
      links={assistantLinks}
      aboveNav={aboveNav}
    >
      {tree}
    </AssistantProvider>
  );
  // Pages outside a project: pickers, administration and unknown addresses.
  const frame = (children: ReactNode, wide = false) =>
    withAssistant(
      <div className="picker-page">
        <header>
          <Brand />
          <div className="topbar-actions">
            {languageControl}
            {userMenu()}
          </div>
        </header>
        <main id="main" className={wide ? "admin-main" : "picker-main"}>
          {signout.error && <Alert kind="error">{signout.error}</Alert>}
          {children}
        </main>
      </div>,
    );
  // The workspace of a project page, shared with the project scope of the
  // settings center so both give module code the same context.
  const workspaceValue = (
    open: Project,
    canEdit: boolean,
    isOwner: boolean,
  ): WorkspaceContextValue => ({
    project: open,
    identity: me,
    locale,
    t,
    canEdit,
    isOwner,
    revision,
    refresh: () => setRevision((n) => n + 1),
    href: (path) => rewriteLegacyHref(table, open.id, path),
  });
  if (standalone)
    return frame(
      <StandaloneContext.Provider
        value={{
          locale,
          t,
          identity: me,
          setLocale,
          refreshIdentity: identity.refresh,
        }}
      >
        <standalone.component />
      </StandaloneContext.Provider>,
      ["account", "account-assistant", "assistant"].includes(standalone.key),
    );
  // The system administration (ADR 0013); the API refuses everyone else.
  if (place.kind === "admin")
    return me.systemAdmin
      ? frame(
          <AdminArea
            section={place.section}
            id={place.id}
            locale={locale}
            currentUserId={me.user.id}
            connections={Boolean(me.connections)}
          />,
          true,
        )
      : frame(<NotFound t={t} project={false} />);
  if (place.kind === "organizationSettings")
    return me.workspaces.some(
      (w) => w.id === place.organizationId && w.canManage,
    ) || me.systemAdmin
      ? frame(
          <>
            <Link
              className="back-link"
              href={`/o/${encodeURIComponent(place.organizationId)}`}
            >
              ← {t("chooseProject")}
            </Link>
            <OrganizationManager
              organizationId={place.organizationId}
              locale={locale}
            />
            <OrganizationIntegrations
              identity={me}
              organizationId={place.organizationId}
              locale={locale}
            />
          </>,
          true,
        )
      : frame(<NotFound t={t} project={false} />);
  // The agents of all projects (ADR 0021); the summary API lists only
  // projects the member may read agents in.
  if (place.kind === "organizationAgents")
    return me.workspaces.some((w) => w.id === place.organizationId)
      ? frame(
          <>
            <Link
              className="back-link"
              href={`/o/${encodeURIComponent(place.organizationId)}`}
            >
              ← {t("chooseProject")}
            </Link>
            <OrganizationAgents
              organizationId={place.organizationId}
              locale={locale}
            />
          </>,
          true,
        )
      : frame(<NotFound t={t} project={false} />);
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
  // The settings center; with its flag off /manage stays not found.
  if (place.kind === "manage" && center) {
    if (center.kind === "off" || center.kind === "notFound")
      return frame(<NotFound t={t} project={false} />);
    if (center.kind === "loading" || center.kind === "redirect")
      return (
        <div className="boot">
          <Brand />
          <Loading label={t("loading")} />
        </div>
      );
    if (center.kind === "error")
      return frame(
        <>
          <Alert kind="error">{center.message}</Alert>
          <Button onClick={caps.refresh}>{t("retry")}</Button>
        </>,
      );
    if (!caps.data) return frame(<NotFound t={t} project={false} />);
    const view = (
      <ScopeView
        scope={center.scope}
        capabilities={center.capabilities}
        name={center.name}
        target={place.target}
        caps={caps.data}
        identity={me}
        locale={locale}
        navigate={(href) => router.push(href)}
      />
    );
    const standaloneValue = {
      locale,
      t,
      identity: me,
      setLocale,
      refreshIdentity: identity.refresh,
    };
    if (center.scope.kind !== "project")
      return frame(
        <StandaloneContext.Provider value={standaloneValue}>
          {view}
        </StandaloneContext.Provider>,
        true,
      );
    // The project scope gives module sections the context of a project page:
    // the role is the project role, as no module page is open.
    if (!project || !shell) return frame(<NotFound t={t} project={false} />);
    const scopeRole =
      project.role ||
      me.workspaces.find((w) => w.id === project.workspaceId)?.role ||
      "viewer";
    return frame(
      <StandaloneContext.Provider value={standaloneValue}>
        <ShellContext.Provider value={shell}>
          <WorkspaceContext.Provider
            value={workspaceValue(
              project,
              scopeRole === "editor" || scopeRole === "owner",
              scopeRole === "owner",
            )}
          >
            {/* Remounts when modules switch: module sections bring hooks. */}
            <div
              key={`${project.id}:manage:${shell.modules
                .filter((m) => m.enabled)
                .map((m) => m.id)
                .join(",")}`}
            >
              {waitsForModuleStates(
                moduleStates.data,
                moduleStates.error,
                lastStates,
                project.id,
              ) ? (
                <Loading label={t("loading")} />
              ) : (
                view
              )}
            </div>
          </WorkspaceContext.Provider>
        </ShellContext.Provider>
      </StandaloneContext.Provider>,
      true,
    );
  }
  if (place.kind === "organizations")
    return frame(<OrganizationPicker identity={me} t={t} />);
  if (place.kind === "organization")
    return frame(
      <ProjectPicker
        identity={me}
        organizationId={place.organizationId}
        t={t}
        locale={locale}
        create={{
          onSubmit: createProject,
          pending: mutation.pending,
          error: mutation.error,
        }}
      />,
    );
  if (!project || !shell)
    return frame(<NotFound t={t} project={Boolean(projectId)} />);
  const route: Route | null =
    place.kind === "view"
      ? (shell.table.routes.find((r) => r.key === place.route.key) ??
        place.route)
      : null;
  const projectRole =
    project.role ||
    me.workspaces.find((w) => w.id === project.workspaceId)?.role ||
    "viewer";
  const moduleRole = shell.modules.find(
    (module) => module.id === (route?.moduleId ?? route?.requiresModule),
  )?.access;
  const role = moduleRole ?? projectRole;
  const isOwner = role === "owner",
    canEdit = role === "editor" || role === "owner";
  const organization = me.workspaces.find((w) => w.id === project.workspaceId);
  // A page of a module, or a platform page that needs one (WP2.4).
  const isOn = (id: string) =>
    Boolean(shell.modules.find((m) => m.id === id)?.enabled);
  const moduleOff = Boolean(route && !routeEnabled(route, isOn));
  // Off only because the member's access is below the module's minAccess:
  // a no-access notice instead of "turned off" (or the server's 403s).
  const noAccess = (() => {
    const id = route?.moduleId ?? route?.requiresModule;
    const module = registry.modules.find((m) => m.id === id);
    if (!id || !module?.minAccess) return false;
    const states = knownStates?.modules;
    return (
      moduleShown(states, id, module.optIn === true) &&
      !moduleShown(states, id, module.optIn === true, module.minAccess)
    );
  })();
  const navGroups = withSettingsLinks(
    buildNavGroups(shell.table.routes, shell.modules),
    shell.modules,
    (key) => settingsSectionHref(shell.hrefOf("settings"), key),
  );
  const mobileBar = mobileEntries(shell.table.routes, isOn);
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
  return withAssistant(
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
          // A link to a section of the page that is already open changes only
          // the search, which the pathname effect does not see: close the
          // drawer on any link click inside it.
          onClick={(event) => {
            if ((event.target as Element).closest("a[href]")) setMenu(false);
          }}
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
            <p>{t("brandTagline")}</p>
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
                crumbs(route, shell.table, locale, groupLabel).map(
                  (part, i, all) =>
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
              {userMenu(project.workspaceId, role)}
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
              value={workspaceValue(project, canEdit, isOwner)}
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
                  <ModuleOff t={t} homeHref={homeHref} noAccess={noAccess} />
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
              fields={projectFields(t, locale)}
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
    </ShellContext.Provider>,
    true,
  );
}
export function ModuleOff({
  t,
  homeHref,
  noAccess = false,
}: {
  t: Text;
  homeHref: string;
  noAccess?: boolean;
}) {
  return (
    <Alert kind="warning">
      <strong>{t(noAccess ? "moduleNoAccess" : "moduleOff")}</strong>
      <p>{t(noAccess ? "moduleNoAccessHint" : "moduleOffHint")}</p>
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
  passwordReset,
  oauthLogin,
  locale,
  setLocale,
  onDone,
}: {
  setup: boolean;
  /** Whether "forgot password" is offered (system mail, ADR 0013). */
  passwordReset: boolean;
  /** Signing in continues the OAuth authorization in the page URL. */
  oauthLogin: boolean;
  locale: Locale;
  setLocale: (l: Locale) => void;
  onDone: () => void;
}) {
  const t: Text = (k) => translate(locale, k);
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
              ? "Deine modulare Arbeitsplattform. Eigene Infrastruktur. Nachvollziehbare Entscheidungen."
              : "Your modular work platform. Your infrastructure. Decisions you can trace."}
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
          {!setup && passwordReset && (
            <Link className="auth-forgot" href="/reset-password">
              {t("forgotPassword")}
            </Link>
          )}
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
