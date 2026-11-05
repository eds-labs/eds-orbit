import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { addCounts, redact, type RedactionCounts } from "../../platform/privacy/redact.ts";
import { DomainError } from "../../shared.ts";
import type { shareableFields } from "./issues.ts";

// The text of a GitHub issue created from an Orbit issue (slice 1). Pure:
// no database, no network. The text is built from the shareable fields
// only; the strict redaction gate reports what it would remove and the
// caller refuses to send anything it flags.

const TITLE_LIMIT = 256;
const MAX_ISSUE_NUMBER = 2 ** 31 - 1;

export const REQUEST_MARKER = (requestId: string) => `<!-- orbit-ref:${requestId} -->`;

export function issueOrbitUrl(projectId: string, issueId: string) {
  return new URL(`/p/${projectId}/issues/list?issue=${issueId}`, loadConfig().APP_ORIGIN).href;
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  // Do not leave half of a surrogate pair at the cut.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function githubIssueText(
  fields: ReturnType<typeof shareableFields>,
  input: { requestId: string; orbitUrl: string },
): { title: string; body: string; hits: Record<string, number> } {
  const title = truncate(`[${fields.key}] ${fields.title}`, TITLE_LIMIT);
  const lines = [
    REQUEST_MARKER(input.requestId),
    `Orbit-Issue: ${fields.key}`,
    "",
    `**Type:** ${fields.type} · **Severity:** ${fields.severity || "—"} · **Components:** ${fields.components.length ? fields.components.join(", ") : "—"}`,
    "",
    fields.summary,
  ];
  if (fields.acceptanceCriteria.length)
    lines.push("", "### Acceptance criteria", ...fields.acceptanceCriteria.map((c) => `- ${c}`));
  lines.push("", `[Open in Orbit](${input.orbitUrl})`);
  const body = lines.join("\n");

  const counts: RedactionCounts = addCounts(
    redact(title, { profile: "strict" }).counts,
    redact(body, { profile: "strict" }).counts,
  );
  const hits: Record<string, number> = {};
  for (const [kind, n] of Object.entries(counts)) if (n && n > 0) hits[kind] = n;
  return { title, body, hits };
}

/** Refuses text the redaction gate flagged. The error carries no text. */
export function assertNoHits(text: { hits: Record<string, number> }) {
  if (Object.keys(text.hits).length) throw new DomainError("ISSUES_GITHUB_REDACTION_HIT", 409);
}

const NAME = "[A-Za-z0-9_.-]{1,100}";
const ISSUE_URL = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/issues/([1-9][0-9]*)(?:#\\S*)?$`);

/** Only `https://github.com/{owner}/{repo}/issues/{n}`, a `#…` fragment ignored. */
export function parseGithubIssueUrl(url: string): { fullName: string; number: number } {
  const match = ISSUE_URL.exec(url);
  const invalid = () => new DomainError("ISSUES_GITHUB_URL_INVALID", 400);
  if (!match) throw invalid();
  const [, owner, repo, digits] = match as unknown as [string, string, string, string];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") throw invalid();
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number > MAX_ISSUE_NUMBER) throw invalid();
  return { fullName: `${owner}/${repo}`, number };
}

export const githubExternalId = (fullName: string, number: number) => `${fullName}#${number}`;
