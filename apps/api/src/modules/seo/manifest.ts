import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { seoPermissions } from "./permissions.ts";

export const SEO_MODULE_ID = "seo";

export const seoModule: ServerModule = {
  id: SEO_MODULE_ID,
  version: "0.1.0",
  displayName: { en: "SEO", de: "SEO" },
  defaultEnabled: false,
  dependsOn: [],
  entityKinds: [],
  tables: ["SeoWebsite", "SeoWebsiteProperty", "SeoOAuthState"],
  permissions: seoPermissions,
};
