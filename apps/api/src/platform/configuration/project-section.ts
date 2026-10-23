import type { ConfigurationSection } from "./types.ts";

// The project's own settings in the configuration document. Read-only over
// MCP: owners edit them in Orbit (Settings → Project), whose save path
// writes the control plane and has no version number.

const FIELDS = ["name", "timezone", "language", "contentLanguages", "links"] as const;

export const projectSection: ConfigurationSection = {
  label: { en: "Project", de: "Projekt" },
  async read(tx, scope) {
    const project = await tx.project.findFirst({
      where: { id: scope.projectId, workspaceId: scope.workspaceId },
      select: {
        name: true,
        timezone: true,
        language: true,
        contentLanguages: true,
        links: true,
      },
    });
    return {
      version: 0,
      values: project ? { ...project, defaultContentLanguage: project.language } : {},
      fields: Object.fromEntries(
        FIELDS.map((f) => [f, { requirement: "required" as const, editable: false }]),
      ),
      notes: { editIn: "Orbit settings: Project" },
    };
  },
};
