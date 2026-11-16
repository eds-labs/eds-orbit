import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { cmsPermissions } from "./permissions.ts";

/**
 * The module id. `cms`, not `content`: that name is taken by Marketing's
 * entity kind, tool namespace and action prefix (ADR 0029 §1).
 */
export const CMS_MODULE_ID = "cms";

/**
 * The Content module (ADR 0029): versioned, multilingual website content
 * (articles first) with SEO fields, scheduling, approval-bound publication
 * and a versioned delivery API for websites. Off for every project until an
 * owner enables it, and unreachable while ORBIT_CMS is off. Its tables
 * come with the core migration 202611160003_cms_core (CH1.6).
 */
export const cmsModule: ServerModule = {
  id: CMS_MODULE_ID,
  version: "0.1.0",
  displayName: { en: "Content", de: "Inhalte" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "CmsAsset",
    "CmsAuthor",
    "CmsDraft",
    "CmsEntry",
    "CmsEntrySite",
    "CmsPublication",
    "CmsPublicationAttempt",
    "CmsRedirect",
    "CmsRevision",
    "CmsSite",
    "CmsTaxonomyTerm",
  ],
  permissions: cmsPermissions,
};
