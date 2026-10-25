import type { LinkTypeDef } from "../../platform/links/types.ts";
import { PROJECT_READ } from "../../platform/tenancy/permissions.ts";

// Knowledge documents as link targets of other modules (ADR 0016), such as
// a task documented by a specification. The title is the active version's;
// a link never makes a document evidence or changes its rights.

const document: LinkTypeDef = {
  label: { en: "Knowledge document", de: "Wissensdokument" },
  linkPermission: PROJECT_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.knowledgeDocument.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, activeVersionId: true, canonicalUrl: true },
    });
    const versions = await tx.documentVersion.findMany({
      where: {
        projectId: scope.projectId,
        id: { in: rows.map((r) => r.activeVersionId).filter((v): v is string => !!v) },
      },
      select: { id: true, title: true },
    });
    const titles = new Map(versions.map((v) => [v.id, v.title]));
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: (r.activeVersionId && titles.get(r.activeVersionId)) || r.canonicalUrl || "Document",
          status: r.activeVersionId ? "active" : "inactive",
          href: `/p/${scope.projectId}/knowledge`,
        },
      ]),
    );
  },
  async search(tx, scope, query, limit) {
    const versions = await tx.documentVersion.findMany({
      where: {
        projectId: scope.projectId,
        title: { contains: query.slice(0, 100), mode: "insensitive" },
      },
      select: { id: true, documentId: true, title: true },
      take: limit * 4,
    });
    const active = await tx.knowledgeDocument.findMany({
      where: { projectId: scope.projectId, activeVersionId: { in: versions.map((v) => v.id) } },
      select: { id: true, activeVersionId: true },
      take: limit,
    });
    const byVersion = new Map(versions.map((v) => [v.id, v.title]));
    return active.map((d) => ({ id: d.id, title: byVersion.get(d.activeVersionId!) ?? "Document" }));
  },
};

export const knowledgeLinkTypes = { document };
