import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { cmsSwitchedOn } from "./gate.ts";
import { cmsActionTypes } from "./publishing/approval.ts";
import { cmsPublicationSweep, cmsPublishJob, resumePublications } from "./publishing/worker.ts";
import { cmsRoutes } from "./routes.ts";
import { cmsLiveCheckJob } from "./sites/live-check.ts";

/** What the content module plugs into the platform; later steps add to it. */
export const cmsContributions: ModuleContributions = {
  available: cmsSwitchedOn,
  unavailableCode: "CMS_DISABLED",
  routes: cmsRoutes,
  // Publishing, updating, scheduling and withdrawing content: W2, decided by
  // the owner or a content editor (decision E-4), never by a mandate (CH1.10).
  actionTypes: cmsActionTypes,
  // Scheduled publications go live on the worker; lost jobs are queued again.
  // Live checks confirm a site shows the live revision (CH1.11).
  jobs: [cmsPublishJob, cmsLiveCheckJob],
  periodic: [cmsPublicationSweep],
  hooks: {
    onProjectResume: async (tx, scope, { generation }) => {
      await resumePublications(tx, scope, generation);
    },
  },
  // Content-free facts about publications for other modules (CH1.15 contract).
  events: {
    publishes: [
      "cms.entry.published",
      "cms.entry.updated",
      "cms.entry.unpublished",
      "cms.entry.scheduled",
      "cms.publication.needs_attention",
    ],
  },
  // Scopes of project API keys for the versioned routes (CH1.1); the routes
  // themselves arrive with CH1.12 (delivery, preview) and CH1.13 (management).
  // Events websites subscribe to for revalidation or rebuilds (CH1.3); the
  // publishing core emits them (CH1.10, CH1.11).
  webhookEvents: [
    { type: "cms.entry.published", description: { en: "An entry was published", de: "Ein Eintrag wurde veröffentlicht" } },
    { type: "cms.entry.updated", description: { en: "A published entry was updated", de: "Ein veröffentlichter Eintrag wurde aktualisiert" } },
    { type: "cms.entry.unpublished", description: { en: "An entry was withdrawn", de: "Ein Eintrag wurde zurückgezogen" } },
    { type: "cms.entry.scheduled", description: { en: "A publication was scheduled", de: "Eine Veröffentlichung wurde geplant" } },
    { type: "cms.redirect.created", description: { en: "A redirect was created", de: "Eine Weiterleitung wurde angelegt" } },
  ],
  apiScopes: [
    { key: "cms:delivery.read", access: "read", description: { en: "Read published content of the key's sites", de: "Veröffentlichte Inhalte der Websites des Schlüssels lesen" } },
    { key: "cms:preview.read", access: "read", description: { en: "Read draft previews with a preview token", de: "Entwurfsvorschauen mit Vorschau-Token lesen" } },
    { key: "cms:manage.read", access: "read", description: { en: "Read entries, drafts, revisions and media", de: "Einträge, Entwürfe, Versionen und Medien lesen" } },
    { key: "cms:manage.write", access: "write", description: { en: "Create and edit drafts and media", de: "Entwürfe und Medien anlegen und bearbeiten" } },
    { key: "cms:publish.propose", access: "write", description: { en: "Propose publications for approval in Orbit", de: "Veröffentlichungen zur Freigabe in Orbit vorschlagen" } },
  ],
};
