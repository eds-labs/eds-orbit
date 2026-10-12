// Target profile "uliquid-blog-json-v1" (R81): pure functions that turn an Orbit
// article into the website's blog post JSON and validate it. The validation is a
// port of the website's content/blog/blog-posts.mjs (same rules, same messages);
// the Orbit rules on top are stricter. No I/O happens here.
export const PROFILE_ID = "uliquid-blog-json-v1";

export class ProfileError extends Error {
  constructor(
    public code: string,
    public detail?: string,
  ) {
    super(code);
    this.name = "ProfileError";
  }
}

export type ArticleMeta = {
  seoTitle: string;
  description: string;
  excerpt: string;
  category: string;
  keywords: string[];
  relatedLinks: { label: string; href: string }[];
};
export type Section = {
  heading: string;
  paragraphs: string[];
  list?: string[];
};
export type BlogPostJson = {
  slug: string;
  title: string;
  seoTitle: string;
  description: string;
  category: string;
  publishedAt: string;
  updatedAt: string;
  readTime: string;
  author: string;
  authorTitle: string;
  keywords: string[];
  excerpt: string;
  sections: Section[];
  relatedLinks: { label: string; href: string }[];
};

/**
 * Check runs that must have succeeded on Orbit's head before the merge (R83):
 * the website's GitHub Actions job. Renaming that job in the website
 * repository requires changing this list, else deliveries end in
 * `checks_timeout`.
 */
export const REQUIRED_CHECKS: readonly string[] = ["check"];

export const AUTHOR = "Mario Euchner";
export const AUTHOR_TITLE = "Founder & Product Lead";
const WORDS_PER_MINUTE = 220;
const MAX_SLUG_LENGTH = 80;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const READ_TIME_PATTERN = /^[1-9]\d? min read$/;
const INTERNAL_HREF_PATTERN = /^\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$/;
const FORBIDDEN_CLAIMS =
  /guaranteed returns|investment advice|autonomous asset manager/i;
const POST_KEYS = [
  "slug",
  "title",
  "seoTitle",
  "description",
  "category",
  "publishedAt",
  "updatedAt",
  "readTime",
  "author",
  "authorTitle",
  "keywords",
  "excerpt",
  "sections",
  "relatedLinks",
];
const SECTION_KEYS = ["heading", "paragraphs", "list"];
const LINK_KEYS = ["label", "href"];
const LIMITS: Record<string, number> = {
  title: 120,
  seoTitle: 70,
  description: 200,
  category: 40,
  excerpt: 320,
  heading: 120,
};

const BASE_ALLOWLIST = [
  "/platform/",
  "/features/",
  "/features/dashboard-portfolio/",
  "/features/market-intelligence/",
  "/features/trading-desk/",
  "/features/ai-workbench/",
  "/features/automation-bots/",
  "/features/bot-vaults/",
  "/pricing/",
  "/resources/",
  "/risk-disclosure/",
  "/faq/",
  "/about/",
];

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function slugify(title: string): string {
  let slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH + 1);
    const cut = slug.lastIndexOf("-");
    slug = (
      cut > 0 ? slug.slice(0, cut) : slug.slice(0, MAX_SLUG_LENGTH)
    ).replace(/-+$/g, "");
  }
  if (!slug) throw new ProfileError("BLOG_SLUG_INVALID");
  return slug;
}

const bodyError = (detail: string): never => {
  throw new ProfileError("BLOG_BODY_FORMAT", detail);
};

/** Parses the restricted markdown subset: "## heading", paragraphs and one "- " list per section. */
export function parseArticleBody(body: string): Section[] {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) blocks.push(current);
      current = [];
    } else if (/^#{1,6}(\s|$)/.test(line)) {
      // A heading line always forms its own block, with or without blank lines around it.
      if (current.length) blocks.push(current);
      blocks.push([line]);
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current);

  const sections: Section[] = [];
  let section: Section | undefined;
  for (const block of blocks) {
    const first = block[0]!;
    if (/^#{1,6}(\s|$)/.test(first)) {
      if (!/^## \S/.test(first) || block.length > 1)
        bodyError(
          `only single-line "## " headings are allowed: ${first.slice(0, 60)}`,
        );
      section = { heading: first.slice(3).trim(), paragraphs: [] };
      checkInline(section.heading);
      sections.push(section);
      continue;
    }
    if (!section) bodyError('text before the first "## " heading');
    const current = section!;
    if (/^[-*+] /.test(first)) {
      if (!block.every((l) => /^- \S/.test(l)))
        bodyError('list items must all start with "- "');
      if (current.list) bodyError("only one list per section is allowed");
      current.list = block.map((l) => l.slice(2).trim());
      current.list.forEach(checkInline);
      continue;
    }
    if (current.list)
      bodyError(`text after a list in section "${current.heading}"`);
    if (
      block.some((l) =>
        /^([-*+] |\d+[.)] |> |\||```|~~~|---|===)/.test(l.trim()),
      )
    )
      bodyError(`unsupported markdown block: ${first.slice(0, 60)}`);
    const text = block.map((l) => l.trim()).join(" ");
    checkInline(text);
    current.paragraphs.push(text);
  }
  if (!sections.length) bodyError("body has no sections");
  return sections;
}

function checkInline(text: string): void {
  if (/!\[|\]\(|\[[^\]]*\]\[/.test(text))
    bodyError("links and images are not allowed");
  if (/<\/?[A-Za-z!][^>]*>/.test(text)) bodyError("HTML is not allowed");
  if (/`/.test(text)) bodyError("code is not allowed");
  if (/\*\*|__|(^|\s)\*\S|\S\*(\s|$)/.test(text))
    bodyError("emphasis is not allowed");
}

export function readTime(sections: Section[]): string {
  return `${Math.max(1, Math.ceil(countBodyWords(sections) / WORDS_PER_MINUTE))} min read`;
}

function countBodyWords(sections: Section[]): number {
  return sections.reduce(
    (n, s) =>
      n +
      wordCount(s.heading) +
      s.paragraphs.reduce((a, p) => a + wordCount(p), 0) +
      (s.list ?? []).reduce((a, p) => a + wordCount(p), 0),
    0,
  );
}

/** `date` is used for both publishedAt and updatedAt. */
export function toPostJson(input: {
  title: string;
  body: string;
  article: ArticleMeta;
  date: string;
}): BlogPostJson {
  const { title, article, date } = input;
  const sections = parseArticleBody(input.body);
  return {
    slug: slugify(title),
    title,
    seoTitle: article.seoTitle,
    description: article.description,
    category: article.category,
    publishedAt: date,
    updatedAt: date,
    readTime: readTime(sections),
    author: AUTHOR,
    authorTitle: AUTHOR_TITLE,
    keywords: article.keywords,
    excerpt: article.excerpt,
    sections,
    relatedLinks: article.relatedLinks,
  };
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  errors: string[],
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${label}: unknown field "${key}"`);
}

function checkText(
  value: unknown,
  label: string,
  errors: string[],
  maxLength?: number,
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label}: must be a non-empty string`);
    return;
  }
  if (value !== value.trim())
    errors.push(`${label}: must not start or end with whitespace`);
  if (maxLength && value.length > maxLength)
    errors.push(
      `${label}: must be at most ${maxLength} characters (has ${value.length})`,
    );
}

function checkTextList(
  value: unknown,
  label: string,
  errors: string[],
  min: number,
  max: number,
) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${label}: must be a list with ${min} to ${max} entries`);
    return;
  }
  value.forEach((entry, index) =>
    checkText(entry, `${label}[${index}]`, errors),
  );
  if (new Set(value).size !== value.length)
    errors.push(`${label}: entries must be unique`);
}

function checkDate(value: unknown, label: string, errors: string[]): boolean {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    errors.push(`${label}: must be a date in YYYY-MM-DD format`);
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    errors.push(`${label}: is not a valid calendar date`);
    return false;
  }
  return true;
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value))
    value.forEach((entry) => collectStrings(entry, strings));
  else if (isPlainObject(value))
    Object.values(value).forEach((entry) => collectStrings(entry, strings));
  return strings;
}

/** Website rules (port of validateBlogPost). An empty list means the post is valid. */
export function validatePost(post: unknown, expectedSlug?: string): string[] {
  const errors: string[] = [];
  if (!isPlainObject(post)) return ["post: must be a JSON object"];

  checkKeys(post, POST_KEYS, "post", errors);
  for (const key of POST_KEYS)
    if (!(key in post)) errors.push(`${key}: is required`);

  if (typeof post.slug !== "string" || !SLUG_PATTERN.test(post.slug))
    errors.push(
      "slug: must be lowercase kebab-case (a-z, 0-9, single hyphens)",
    );
  else if (expectedSlug !== undefined && post.slug !== expectedSlug)
    errors.push(
      `slug: "${post.slug}" must match the file name "${expectedSlug}.json"`,
    );

  for (const key of ["title", "seoTitle", "description", "category", "excerpt"])
    checkText(post[key], key, errors, LIMITS[key]);
  checkText(post.author, "author", errors);
  checkText(post.authorTitle, "authorTitle", errors);

  const publishedOk = checkDate(post.publishedAt, "publishedAt", errors);
  const updatedOk = checkDate(post.updatedAt, "updatedAt", errors);
  if (publishedOk && updatedOk && post.updatedAt < post.publishedAt)
    errors.push("updatedAt: must not be earlier than publishedAt");

  if (
    typeof post.readTime !== "string" ||
    !READ_TIME_PATTERN.test(post.readTime)
  )
    errors.push('readTime: must look like "7 min read"');

  checkTextList(post.keywords, "keywords", errors, 1, 12);

  if (!Array.isArray(post.sections) || post.sections.length === 0)
    errors.push("sections: must contain at least one section");
  else {
    post.sections.forEach((section: unknown, index: number) => {
      const label = `sections[${index}]`;
      if (!isPlainObject(section)) {
        errors.push(`${label}: must be an object`);
        return;
      }
      checkKeys(section, SECTION_KEYS, label, errors);
      checkText(section.heading, `${label}.heading`, errors, LIMITS.heading);
      checkTextList(section.paragraphs, `${label}.paragraphs`, errors, 1, 20);
      if ("list" in section)
        checkTextList(section.list, `${label}.list`, errors, 1, 20);
    });
    const headings = post.sections.map((s: any) => s?.heading);
    if (new Set(headings).size !== headings.length)
      errors.push("sections: headings must be unique");
  }

  if (!Array.isArray(post.relatedLinks) || post.relatedLinks.length > 8)
    errors.push("relatedLinks: must be a list with at most 8 entries");
  else {
    post.relatedLinks.forEach((link: unknown, index: number) => {
      const label = `relatedLinks[${index}]`;
      if (!isPlainObject(link)) {
        errors.push(`${label}: must be an object`);
        return;
      }
      checkKeys(link, LINK_KEYS, label, errors);
      checkText(link.label, `${label}.label`, errors);
      if (
        typeof link.href !== "string" ||
        !INTERNAL_HREF_PATTERN.test(link.href)
      )
        errors.push(
          `${label}.href: must be an internal path with a trailing slash, e.g. "/platform/"`,
        );
    });
    const hrefs = post.relatedLinks.map((l: any) => l?.href);
    if (new Set(hrefs).size !== hrefs.length)
      errors.push("relatedLinks: hrefs must be unique");
  }

  if (collectStrings(post).some((text) => FORBIDDEN_CLAIMS.test(text)))
    errors.push(
      "content: contains a forbidden claim (guaranteed returns, investment advice or autonomous asset manager)",
    );
  return errors;
}

export const linkAllowlist = (existingSlugs: string[]): string[] => [
  ...BASE_ALLOWLIST,
  ...existingSlugs.map((slug) => `/blog/${slug}/`),
];

/** Orbit rules on top of the website rules: 2-4 allowlisted links, 5-8 sections, 1000-2200 words. */
export function checkOrbitRules(
  post: BlogPostJson,
  allowlist: string[],
): string[] {
  const errors: string[] = [];
  if (post.relatedLinks.length < 2 || post.relatedLinks.length > 4)
    errors.push("relatedLinks: needs 2 to 4 entries");
  post.relatedLinks.forEach((link, index) => {
    if (!allowlist.includes(link.href))
      errors.push(
        `relatedLinks[${index}].href: "${link.href}" is not in the allowlist`,
      );
  });
  if (post.sections.length < 5 || post.sections.length > 8)
    errors.push("sections: needs 5 to 8 sections");
  const words = countBodyWords(post.sections);
  if (words < 1000 || words > 2200)
    errors.push(`body: needs 1000 to 2200 words (has ${words})`);
  return errors;
}

export const postFileBytes = (post: BlogPostJson): string =>
  JSON.stringify(post, null, 2) + "\n";
