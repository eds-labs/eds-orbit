import type { BlogPreview } from "./assignments";
import { Badge } from "./ui/primitives";

/**
 * Why a website article cannot be released yet (R81, spec §7 "Release"):
 * the first problem of its preview, else a slug that already exists in the
 * posts directory; null when the release is open.
 */
export function releaseBlock(preview: BlogPreview, de: boolean) {
  if (preview.problems.length) return preview.problems[0]!;
  if (preview.slugTaken)
    return de ? "Slug existiert bereits" : "Slug already exists";
  return null;
}

/** A related link of the post, absolute on the website when it resolves. */
function siteHref(href: string, liveUrl: string) {
  try {
    const url = new URL(href, liveUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The website article as the target profile builds it (R81): title, meta
 * line, description, sections with their lists, related links, the address
 * it gets on the website and the problems that block its release.
 */
export function BlogPreviewCard({
  preview,
  de,
}: {
  preview: BlogPreview;
  de: boolean;
}) {
  const { post } = preview;
  return (
    <div className="blog-preview">
      <h3>{post.title}</h3>
      <p className="panel-note">
        {[
          post.category,
          post.publishedAt,
          post.readTime,
          `${post.author}, ${post.authorTitle}`,
        ].join(" · ")}
      </p>
      <p>{post.description}</p>
      {post.sections.map((section, index) => (
        <section key={`${index}:${section.heading}`}>
          <h4>{section.heading}</h4>
          {section.paragraphs.map((paragraph, at) => (
            <p key={at}>{paragraph}</p>
          ))}
          {section.list && section.list.length > 0 && (
            <ul>
              {section.list.map((entry, at) => (
                <li key={at}>{entry}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {post.relatedLinks.length > 0 && (
        <>
          <h4>{de ? "Weiterführende Links" : "Related links"}</h4>
          <ul>
            {post.relatedLinks.map((link) => {
              const href = siteHref(link.href, preview.liveUrl);
              return (
                <li key={link.href}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {link.label}
                    </a>
                  ) : (
                    link.label
                  )}{" "}
                  <small>({link.href})</small>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="panel-note">
        <strong>{de ? "Ziel-URL" : "Target URL"}:</strong>{" "}
        <code>{preview.liveUrl}</code>
      </p>
      {preview.problems.length > 0 && (
        <ul
          className="blog-preview-problems"
          aria-label={de ? "Probleme" : "Problems"}
        >
          {preview.problems.map((problem) => (
            <li key={problem}>
              <Badge tone="warning">{problem}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
