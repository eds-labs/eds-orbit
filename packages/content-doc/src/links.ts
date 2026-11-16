import { LIMITS } from "./types.ts";

const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029]/;

/**
 * The one link rule for editor, validator and renderer: `https:`, `mailto:`,
 * site-relative paths (`/…`, never `//…` or `/\…`) and `#anchors`. No
 * whitespace or control characters, at most {@link LIMITS.href} characters.
 */
export function linkAllowed(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > LIMITS.href) return false;
  if (CONTROL_OR_SPACE.test(href)) return false;
  if (href.startsWith("#")) return href.length > 1;
  if (href.startsWith("/")) return !href.startsWith("//") && !href.startsWith("/\\");
  if (href.includes("\\")) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol === "mailto:") return url.pathname.length > 0;
  if (url.protocol !== "https:") return false;
  // No credentials in links: they are phishing material and leak secrets.
  return url.username === "" && url.password === "" && url.hostname.length > 0;
}

/** True for links that leave the site: absolute `https:` and `mailto:` links. */
export function isExternalLink(href: string, siteOrigins: readonly string[] = []): boolean {
  if (href.startsWith("/") || href.startsWith("#")) return false;
  if (href.startsWith("mailto:")) return true;
  try {
    const origin = new URL(href).origin;
    return !siteOrigins.some((candidate) => {
      try {
        return new URL(candidate).origin === origin;
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}
