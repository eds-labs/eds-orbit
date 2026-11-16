import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { cmsSwitchedOn } from "./gate.ts";
import { cmsRoutes } from "./routes.ts";

/** What the content module plugs into the platform; later steps add to it. */
export const cmsContributions: ModuleContributions = {
  available: cmsSwitchedOn,
  unavailableCode: "CMS_DISABLED",
  routes: cmsRoutes,
  // Scopes of project API keys for the versioned routes (CH1.1); the routes
  // themselves arrive with CH1.12 (delivery, preview) and CH1.13 (management).
  apiScopes: [
    { key: "cms:delivery.read", access: "read", description: { en: "Read published content of the key's sites", de: "Veröffentlichte Inhalte der Websites des Schlüssels lesen" } },
    { key: "cms:preview.read", access: "read", description: { en: "Read draft previews with a preview token", de: "Entwurfsvorschauen mit Vorschau-Token lesen" } },
    { key: "cms:manage.read", access: "read", description: { en: "Read entries, drafts, revisions and media", de: "Einträge, Entwürfe, Versionen und Medien lesen" } },
    { key: "cms:manage.write", access: "write", description: { en: "Create and edit drafts and media", de: "Entwürfe und Medien anlegen und bearbeiten" } },
    { key: "cms:publish.propose", access: "write", description: { en: "Propose publications for approval in Orbit", de: "Veröffentlichungen zur Freigabe in Orbit vorschlagen" } },
  ],
};
