import { createIssuesProject } from "./issues-project.ts";

/**
 * A synthetic project for the social module (ADR 0020): an owner, an
 * editor and a viewer with the social module enabled. Same shape as the
 * issue center's fixture; no test reaches a provider.
 */
export function createSocialProject(
  options: { name?: string; modules?: string[] } = {},
) {
  return createIssuesProject({
    name: options.name ?? "Synthetic social",
    modules: options.modules ?? ["social"],
  });
}
