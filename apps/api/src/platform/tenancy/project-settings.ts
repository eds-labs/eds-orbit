import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import {
  languageCode,
  normalizeLanguageCode,
  projectLanguages,
  projectLinks,
  type ProjectLink,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../shared.ts";

// The project-wide settings (owner action "project-settings"): name,
// timezone, content languages with their default, and the public profile
// links. `language` remains the default content language; a caller that
// still sends only `language` (before the language list) keeps working.

const input = z
  .object({
    name: z.string().min(1).max(100),
    timezone: z.string(),
    language: z.string().max(20).optional(),
    contentLanguages: z.array(z.string().max(20)).optional(),
    defaultContentLanguage: z.string().max(20).optional(),
    links: z.array(z.unknown()).optional(),
  })
  .strict();

export type ProjectSettingsChange = {
  name: string;
  timezone: string;
  language: string;
  contentLanguages: string[];
  links?: ProjectLink[];
};

/**
 * The validated change against the current languages: an explicit list
 * needs its default among it (the default falls back to `language`); only
 * `language` adds that language to the current list; links absent leave
 * them unchanged.
 */
export function projectSettingsChange(
  raw: unknown,
  current: { language: string; contentLanguages: readonly string[] },
): ProjectSettingsChange {
  const i = input.parse(raw);
  try {
    new Intl.DateTimeFormat("en", { timeZone: i.timezone });
  } catch {
    throw new DomainError("INVALID_TIMEZONE");
  }
  const wantedDefault = i.defaultContentLanguage ?? i.language;
  let languages: { contentLanguages: string[]; defaultContentLanguage: string };
  if (i.contentLanguages) {
    languages = projectLanguages.parse({
      contentLanguages: i.contentLanguages.map(normalizeLanguageCode),
      defaultContentLanguage: normalizeLanguageCode(
        wantedDefault ?? i.contentLanguages[0] ?? "",
      ),
    });
  } else {
    const fallback = languageCode.parse(
      normalizeLanguageCode(wantedDefault ?? current.language),
    );
    languages = {
      contentLanguages: current.contentLanguages.includes(fallback)
        ? [...current.contentLanguages]
        : [...current.contentLanguages, fallback],
      defaultContentLanguage: fallback,
    };
  }
  return {
    name: i.name,
    timezone: i.timezone,
    language: languages.defaultContentLanguage,
    contentLanguages: languages.contentLanguages,
    ...(i.links ? { links: projectLinks.parse(i.links) } : {}),
  };
}

export async function updateProjectSettings(scope: Scope, raw: unknown) {
  const current = await authDb.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { language: true, contentLanguages: true },
  });
  const change = projectSettingsChange(raw, current);
  const project = await authDb.project.update({
    where: { id: scope.projectId },
    data: change,
  });
  // Content-free: which languages, how many links, never their addresses.
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    audit(tx, scope, "project_settings.update", scope.projectId, {
      language: change.language,
      contentLanguages: change.contentLanguages,
      ...(change.links ? { linkCount: change.links.length } : {}),
    }),
  );
  return project;
}
