import { createElement, Fragment, type ReactNode } from "react";
import type {
  IntegrationContribution,
  Label,
  SettingsSection,
} from "@/platform/shell/types";
import type {
  Area,
  Capability,
  ManagementSection,
  ResolvedSection,
  ScopeKind,
  SectionMeta,
  SectionProps,
} from "./types";

// Area labels live here and not in texts.ts: the area list is the registry's
// own vocabulary and validation needs it before any wording file is loaded.
const LABELS = {
  overview: { en: "Overview", de: "Übersicht" },
  users: { en: "Users", de: "Benutzer" },
  organizations: { en: "Organizations & projects", de: "Organisationen & Projekte" },
  integrations: { en: "Integrations", de: "Integrationen" },
  ai: { en: "AI", de: "KI" },
  mcp: { en: "MCP", de: "MCP" },
  security: { en: "Security & audit", de: "Sicherheit & Protokoll" },
  members: { en: "Members", de: "Mitglieder" },
  knowledge: { en: "Knowledge", de: "Wissen" },
  policies: { en: "Policies", de: "Richtlinien" },
  profile: { en: "Profile", de: "Profil" },
  modules: { en: "Modules", de: "Module" },
  data: { en: "Data", de: "Daten" },
  connections: { en: "Connections", de: "Verbindungen" },
  assistant: { en: "Assistant", de: "Assistent" },
} as const satisfies Record<string, Label>;

function areas(ids: ReadonlyArray<keyof typeof LABELS>): readonly Area[] {
  return ids.map((id, index) => ({ id, label: LABELS[id], order: index * 10 }));
}

export const AREAS: Readonly<Record<ScopeKind, readonly Area[]>> = {
  system: areas(["overview", "users", "organizations", "integrations", "ai", "mcp", "security"]),
  organization: areas(["overview", "members", "integrations", "ai", "knowledge", "policies"]),
  project: areas(["overview", "profile", "members", "modules", "integrations", "ai", "data"]),
  account: areas(["profile", "connections", "assistant"]),
};

const SEGMENT = /^[a-z][a-z0-9-]*$/;

/** Throws one error listing every problem, like routeTable in the shell. */
export function validateSections(sections: readonly ManagementSection[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    const key = `${s.scope}/${s.area}/${s.id}`;
    if (seen.has(key)) problems.push(`duplicate section ${key}`);
    seen.add(key);
    if (!AREAS[s.scope].some((a) => a.id === s.area)) {
      problems.push(`unknown area ${s.area} in scope ${s.scope} (section ${s.id})`);
    }
    if (!s.id.split("/").every((part) => SEGMENT.test(part))) {
      problems.push(`invalid section id ${s.id}`);
    }
  }
  if (problems.length > 0) {
    throw new Error("SETTINGS_SECTIONS_INVALID: " + problems.join("; "));
  }
}

function areaOrder(scope: ScopeKind, area: string): number {
  return AREAS[scope].find((a) => a.id === area)?.order ?? Number.MAX_SAFE_INTEGER;
}

/** The scope's sections the member holds the capability for, in display order. */
export function visibleSections(
  sections: readonly ManagementSection[],
  scope: ScopeKind,
  capabilities: readonly Capability[],
): ResolvedSection[] {
  return sections
    .filter((s) => s.scope === scope && capabilities.includes(s.capability))
    .sort(
      (x, y) =>
        areaOrder(scope, x.area) - areaOrder(scope, y.area) || x.order - y.order,
    )
    .map(({ component, capability: _capability, ...meta }) => ({
      ...meta,
      render: (props: SectionProps) => createElement(component, props),
    }));
}

const byOrder = <T extends { order: number }>(list: readonly T[]) =>
  [...list].sort((x, y) => x.order - y.order);

/**
 * Callers pass only the visible sections, so a hidden section is simply not
 * found. This function has no scope: with no area it opens the area of the
 * first element, and callers pass lists already sorted by area order. A path
 * segment becomes an entity id only for a section that takes one, so an
 * unknown address (e.g. a disabled module's) is not available rather than
 * some other section.
 */
export function resolveSection<
  T extends { area: string; id: string; order: number; takesId?: true },
>(
  sections: readonly T[],
  area: string | null,
  rest: readonly string[],
): { section: T; id?: string } | null {
  const target = area ?? sections[0]?.area;
  if (target === undefined) return null;
  const inArea = byOrder(sections.filter((s) => s.area === target));
  if (inArea.length === 0) return null;

  // 1. Longest id prefix of the path; the next segment is the entity id.
  let best: T | undefined;
  let bestLength = 0;
  for (const s of inArea) {
    const parts = s.id.split("/");
    if (
      parts.length > bestLength &&
      parts.length <= rest.length &&
      parts.every((part, i) => rest[i] === part)
    ) {
      best = s;
      bestLength = parts.length;
    }
  }
  if (best) {
    const extra = rest.slice(bestLength);
    if (extra.length > 1 || (extra.length === 1 && !best.takesId)) return null;
    return { section: best, id: extra[0] };
  }
  // The area's own address belongs to the section named like the area (see
  // sectionPath), else to the area's first section.
  const lead = inArea.find((s) => s.id === target) ?? inArea[0];
  if (rest.length === 0) return { section: lead, id: undefined };
  if (rest.length === 1) {
    // 2. A module name selects the module's first section.
    const ofModule = inArea.find((s) => s.id.startsWith(rest[0] + "/"));
    if (ofModule) return { section: ofModule, id: undefined };
    // 3. Anything else is an entity id of the area's lead section, if it takes one.
    return lead.takesId ? { section: lead, id: rest[0] } : null;
  }
  return null;
}

/**
 * The address of a section below its scope. A section named like its area
 * is the area's own address (`users`, not `users/users`); resolveSection
 * still accepts the long form.
 */
export function sectionPath(section: { area: string; id: string }): string[] {
  if (section.id === section.area) return [section.area];
  return [section.area, ...section.id.split("/")];
}

export function navGroups(
  sections: readonly SectionMeta[],
  scope: ScopeKind,
  moduleName: (id: string) => Label | undefined,
): Array<{ id: string; label: Label; sections: SectionMeta[] }> {
  const groups: Array<{ id: string; label: Label; sections: SectionMeta[] }> = [];
  for (const area of AREAS[scope]) {
    const own = sections.filter((s) => s.area === area.id && !s.moduleId);
    if (own.length > 0) groups.push({ id: area.id, label: area.label, sections: own });
    if (scope === "project" && area.id === "modules") {
      const moduleIds: string[] = [];
      for (const s of sections) {
        if (s.moduleId && !moduleIds.includes(s.moduleId)) moduleIds.push(s.moduleId);
      }
      for (const moduleId of moduleIds) {
        groups.push({
          id: moduleId,
          label: moduleName(moduleId) ?? { en: moduleId, de: moduleId },
          sections: sections.filter((s) => s.moduleId === moduleId),
        });
      }
    }
  }
  return groups;
}

export function searchSections<T extends SectionMeta>(
  sections: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return sections.filter((s) =>
    [s.label, s.description, s.keywords].some(
      (l) =>
        l !== undefined &&
        (l.en.toLowerCase().includes(needle) || l.de.toLowerCase().includes(needle)),
    ),
  );
}

export function moduleSectionId(
  moduleId: string,
  tabKey: string,
  platformKeys: readonly string[],
): string {
  if (tabKey === moduleId || platformKeys.includes(tabKey)) return `${moduleId}/settings`;
  if (tabKey.startsWith(`${moduleId}-`)) return `${moduleId}/${tabKey.slice(moduleId.length + 1)}`;
  return `${moduleId}/${tabKey}`;
}

type Contribution = {
  section: SettingsSection;
  shown: ReturnType<SettingsSection["useSection"]>;
};

/**
 * The module sections of the project settings as settings center sections.
 * Pure: the caller has already run every section's hook (they must run on
 * every render) and passes what each returned. A hidden section (null) is
 * left out; contributions that land on the same id become one section that
 * renders them by their order, as the old page renders a shared tab.
 */
export function adaptModuleSections(
  contributed: readonly Contribution[],
  modules: ReadonlyArray<{ id: string; displayName: Label; description: Label }>,
  platformKeys: readonly string[],
): { sections: ResolvedSection[]; notices: ReactNode[] } {
  const notices: ReactNode[] = [];
  const joined = new Map<string, { moduleId: string; parts: Contribution[] }>();
  for (const c of contributed) {
    if (!c.shown) continue;
    if (c.shown.notice) notices.push(c.shown.notice);
    // The shell sets every module section's group to its module.
    const moduleId = c.section.tab.group;
    if (!moduleId) continue;
    const id = moduleSectionId(moduleId, c.section.tab.key, platformKeys);
    const entry = joined.get(id);
    if (entry) entry.parts.push(c);
    else joined.set(id, { moduleId, parts: [c] });
  }
  // Modules in the order of `modules` (the caller passes the sidebar's);
  // one missing from it goes last.
  const rank = (moduleId: string) => {
    const index = modules.findIndex((m) => m.id === moduleId);
    return index === -1 ? modules.length : index;
  };
  return {
    notices,
    sections: [...joined.entries()]
      .map(([id, { moduleId, parts }]) => ({
        id,
        moduleId,
        parts: [...parts].sort((x, y) => x.section.order - y.section.order),
      }))
      .sort(
        (x, y) =>
          rank(x.moduleId) - rank(y.moduleId) ||
          x.parts[0].section.tab.order - y.parts[0].section.tab.order,
      )
      .map(({ id, moduleId, parts }) => {
        const first = parts[0];
        const shellModule = modules.find((m) => m.id === moduleId);
        const fallback = { en: moduleId, de: moduleId };
        // A module section on a platform tab ("integrations") would carry the
        // platform tab's name; in the center it goes by its module's name.
        const onPlatformTab = platformKeys.includes(first.section.tab.key);
        const contents = parts.map((part) => part.shown!.content);
        return {
          id,
          scope: "project" as const,
          area: "modules",
          moduleId,
          label: onPlatformTab
            ? (shellModule?.displayName ?? fallback)
            : (first.shown!.label ?? first.section.tab.label),
          description: shellModule?.description ?? fallback,
          order: first.section.tab.order,
          render: () =>
            createElement(
              Fragment,
              null,
              ...contents.map((content, index) =>
                createElement(Fragment, { key: index }, content),
              ),
            ),
        };
      }),
  };
}

/** The section id of a module's integration section: "<module id>/<id>". */
export function integrationSectionId(c: { moduleId: string; id: string }): string {
  return `${c.moduleId}/${c.id}`;
}

/**
 * The modules' integration sections (WebModule.integrations) as project
 * sections of the Integrations area, after the platform's own (order 100 +
 * the contribution's). They carry no `moduleId`: navGroups would move them
 * into the module groups, and they belong to the Integrations group. The
 * shell passes only the contributions of modules shown for the project.
 */
export function adaptIntegrationSections(
  contributed: ReadonlyArray<IntegrationContribution & { moduleId: string }>,
): ResolvedSection[] {
  return contributed.map((c) => ({
    id: integrationSectionId(c),
    scope: "project" as const,
    area: "integrations",
    label: c.label,
    description: c.description,
    order: 100 + c.order,
    ...(c.ownHead ? { ownHead: true as const } : {}),
    render: () => createElement(c.component),
  }));
}
