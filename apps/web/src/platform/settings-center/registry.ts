import { createElement } from "react";
import type { Label } from "@/platform/shell/types";
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
 * first element, and callers pass lists already sorted by area order.
 */
export function resolveSection<T extends { area: string; id: string; order: number }>(
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
    if (extra.length > 1) return null;
    return { section: best, id: extra[0] };
  }
  if (rest.length === 0) return { section: inArea[0], id: undefined };
  if (rest.length === 1) {
    // 2. A module name selects the module's first section.
    const ofModule = inArea.find((s) => s.id.startsWith(rest[0] + "/"));
    if (ofModule) return { section: ofModule, id: undefined };
    // 3. Anything else is an entity id of the area's first section.
    return { section: inArea[0], id: rest[0] };
  }
  return null;
}

export function sectionPath(section: { area: string; id: string }): string[] {
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
