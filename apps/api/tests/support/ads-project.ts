import { createIssuesProject } from "./issues-project.ts";

/**
 * A synthetic project for the ads module (ADR 0025): an owner, an editor
 * and a viewer with the ads module enabled. Same shape as the social
 * fixture; no test reaches a provider.
 */
export function createAdsProject(
  options: { name?: string; modules?: string[] } = {},
) {
  return createIssuesProject({
    name: options.name ?? "Synthetic ads",
    modules: options.modules ?? ["ads"],
  });
}
