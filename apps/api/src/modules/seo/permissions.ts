import { permission } from "../../platform/tenancy/permissions.ts";

export const SEO_READ = permission(
  "seo.read",
  "Read SEO websites and organic search performance",
  ["owner", "editor", "viewer"],
);

export const SEO_MANAGE = {
  ...permission("seo.manage", "Manage SEO websites and connections", ["owner"]),
  sensitive: true,
};

export const seoPermissions = [SEO_READ, SEO_MANAGE];
