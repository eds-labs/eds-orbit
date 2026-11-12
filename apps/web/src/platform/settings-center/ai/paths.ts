import type { ManageScope } from "../types";

/**
 * The request paths of the AI area for a scope; a scope without such a
 * resource has no entry. Ids are encoded because they come from the URL.
 */
export function aiPaths(scope: ManageScope): {
  effective?: string;
  projects?: string;
  defaults?: string;
  models?: string;
  profile?: string;
  base?: string;
  overview?: string;
} {
  switch (scope.kind) {
    case "project":
      return {
        effective: `/management/projects/${encodeURIComponent(scope.projectId)}/ai/effective`,
      };
    case "organization": {
      const id = encodeURIComponent(scope.organizationId);
      return {
        projects: `/management/organizations/${id}/ai/projects`,
        defaults: `/organizations/${id}/ai/defaults`,
        models: `/organizations/${id}/ai/models`,
        profile: `/organizations/${id}/ai/profile`,
        base: `/organizations/${id}`,
      };
    }
    case "system":
      return {
        defaults: "/admin/ai/defaults",
        models: "/admin/ai/models",
        profile: "/admin/ai/profile",
        overview: "/admin/overview",
      };
    default:
      return {};
  }
}
