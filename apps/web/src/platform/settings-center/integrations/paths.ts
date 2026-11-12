import type { ManageScope } from "../types";

/**
 * The request paths of the integrations center for a scope; null where the
 * scope has no such resource. Ids are encoded because they come from the URL.
 */
export function integrationPaths(scope: ManageScope): {
  catalog: "/management/integrations/catalog";
  records: string | null;
  connections: string | null;
  overview: string | null;
} {
  const catalog = "/management/integrations/catalog" as const;
  switch (scope.kind) {
    case "project":
      return {
        catalog,
        records: `/management/projects/${encodeURIComponent(scope.projectId)}/integrations`,
        connections: null,
        overview: null,
      };
    case "organization": {
      const id = encodeURIComponent(scope.organizationId);
      return {
        catalog,
        records: `/management/organizations/${id}/integrations`,
        connections: `/organizations/${id}/connections`,
        overview: null,
      };
    }
    case "system":
      return {
        catalog,
        records: null,
        connections: "/admin/connections",
        overview: "/admin/overview",
      };
    default:
      return { catalog, records: null, connections: null, overview: null };
  }
}
