import { z } from "zod";
import { contentType } from "./registry.ts";

// A site's routes per type and locale (ADR 0029 §3.2): e.g.
// { "article": { "de": "/blog/{slug}/", "en": "/en/blog/{slug}/" } }.
// A locale without its own pattern uses the type's default route.

export const routePattern = z
  .string()
  .max(200)
  .regex(/^\/[a-z0-9/-]*\{slug\}[a-z0-9/-]*$/, "path of lower-case segments with {slug}")
  .refine((value) => !value.includes("//"), "no empty segments");

export const siteRoutes = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  z.record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), routePattern),
);
export type SiteRoutes = z.infer<typeof siteRoutes>;

/** The path of an entry on a site, with the site's trailing slash rule. */
export function entryPath(routes: SiteRoutes, type: string, locale: string, slug: string, trailingSlash: boolean) {
  const pattern = routes[type]?.[locale] ?? contentType(type)?.defaultRoute;
  if (!pattern) throw Object.assign(new Error("CMS_ROUTE_UNKNOWN"), { code: "CMS_ROUTE_UNKNOWN" });
  const path = pattern.replace("{slug}", encodeURIComponent(slug));
  const bare = path.replace(/\/+$/, "") || "/";
  return trailingSlash && bare !== "/" ? `${bare}/` : bare;
}

/** The absolute URL of a path on a site's base URL. */
export const absoluteUrl = (baseUrl: string, path: string) => new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
