import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { issueEvent, uuid, type IssueActor } from "./common.ts";
import type { IssueRow } from "./issues.ts";
import { mergeIssue } from "./merge.ts";
import { readIssuesSettings } from "./settings.ts";

// Duplicate detection (ADR 0018 I-3, plan §2.5), cheapest first. Stages 1
// and 2 (exact fingerprint, external reference) attach a report in intake;
// stage 3 here scores lexical candidates and stores them for a person to
// confirm or reject. Two issues are never merged automatically: confirming
// a candidate is a person's merge. Vector and AI stages are not built (MVP).

const DAY = 86_400_000;
const MAX_CANDIDATES = 10;
// Short words and common words in English and German carry no signal.
const STOP = new Set(
  "the and for with when not but are was from that this have has can cannot after into does doesn dont very der die das und mit bei nicht ist ein eine einen beim auf von wenn kein keine wird werden nach oder auch noch aber sich seit sehr".split(" "),
);
// The same product terms in German and English (a small, fixed glossary).
const GLOSSARY: Record<string, string> = {
  anmeldung: "login", anmelden: "login", einloggen: "login", login: "login", signin: "login",
  zahlung: "payment", bezahlung: "payment", bezahlen: "payment", payment: "payment", pay: "payment",
  fehler: "error", error: "error", fehlermeldung: "error",
  absturz: "crash", abstuerzt: "crash", stürzt: "crash", crash: "crash", crashes: "crash",
  einzahlung: "deposit", deposit: "deposit", auszahlung: "withdrawal", withdrawal: "withdrawal", withdraw: "withdrawal",
  passwort: "password", password: "password", konto: "account", account: "account",
  rechnung: "invoice", invoice: "invoice", seite: "page", page: "page", laden: "load", loading: "load", load: "load",
  langsam: "slow", slow: "slow", hängt: "hang", haengt: "hang", hangs: "hang", hang: "hang", freezes: "hang", friert: "hang",
  knopf: "button", schaltfläche: "button", button: "button", funktioniert: "works", works: "works", working: "works",
  benachrichtigung: "notification", notification: "notification", email: "email", mail: "email",
  hochladen: "upload", upload: "upload", herunterladen: "download", download: "download", export: "export", exportieren: "export",
  suche: "search", search: "search", warenkorb: "cart", cart: "cart", kasse: "checkout", checkout: "checkout",
  zurücksetzen: "reset", zurück: "reset", reset: "reset", resets: "reset", lädt: "load",
  gutgeschrieben: "credit", credited: "credit", kontostand: "balance", guthaben: "balance",
  ergebnisse: "result", ergebnis: "result", results: "result", tage: "day", tagen: "day", days: "day",
  doppelt: "double", twice: "double", sprache: "language", englisch: "english", deutsch: "german",
};

/** A light English stemmer, so "charged", "charges" and "charge" meet. */
function stem(word: string) {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && (w.endsWith("ed") || w.endsWith("ly"))) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** Normalized content words: lower case, glossary terms, no stop words or redaction masks. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const plain = text.replace(/\[[a-zA-Z -]+ removed\]/g, " ").toLowerCase();
  for (const raw of plain.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(GLOSSARY[raw] ?? raw));
  }
  return out;
}

const dice = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
};

type Comparable = { title: string; summary: string | null; components: readonly string[]; lastSeenAt: Date };

/**
 * The lexical score of a candidate (stage 3) in [0, 1] and its reason
 * codes: title overlap counts most, then the whole text, then shared
 * components; candidates not seen for a long time weigh less.
 */
export function lexicalScore(a: Comparable, b: Comparable, now = new Date()) {
  const title = dice(tokens(a.title), tokens(b.title));
  const text = dice(tokens(`${a.title} ${a.summary ?? ""}`), tokens(`${b.title} ${b.summary ?? ""}`));
  const components = dice(new Set(a.components), new Set(b.components));
  const age = now.getTime() - b.lastSeenAt.getTime();
  const recency = age <= 30 * DAY ? 1 : age <= 90 * DAY ? 0.9 : 0.75;
  const score = Math.min(1, (0.6 * title + 0.25 * text + 0.15 * components) * recency);
  const reasons = [
    ...(title >= 0.5 ? ["title_overlap"] : title > 0 ? ["title_partial"] : []),
    ...(text >= 0.4 ? ["text_overlap"] : []),
    ...(components > 0 ? ["component_match"] : []),
    ...(recency === 1 ? ["recent"] : []),
  ];
  return { score: Math.round(score * 10_000) / 10_000, reasons };
}

/** Issues that may be the same problem, by full-text match or shared component. */
async function lexicalPool(tx: DbTx, scope: Scope, issue: IssueRow) {
  const words = [...tokens(`${issue.title} ${issue.summary ?? ""}`)].slice(0, 12);
  const glossary = Object.entries(GLOSSARY);
  // Every spelling of a glossary term, so a German report finds an English issue.
  const spellings = [...new Set(words.flatMap((w) => [w, ...glossary.filter(([, v]) => v === w).map(([k]) => k)]))]
    .filter((w) => /^[\p{L}\p{N}]+$/u.test(w))
    .slice(0, 40);
  const since = new Date(Date.now() - 365 * DAY);
  const byText = spellings.length
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Issue"
        WHERE "projectId" = ${scope.projectId}::uuid AND id <> ${issue.id}::uuid
          AND status <> 'duplicate' AND "lastSeenAt" >= ${since}
          AND "searchVector" @@ to_tsquery('simple', ${spellings.map((w) => `${w}:*`).join(" | ")})
        ORDER BY ts_rank_cd("searchVector", to_tsquery('simple', ${spellings.map((w) => `${w}:*`).join(" | ")})) DESC
        LIMIT 30`
    : [];
  const byComponent = issue.components.length
    ? await tx.issue.findMany({
        where: {
          projectId: scope.projectId,
          id: { not: issue.id },
          status: { not: "duplicate" },
          lastSeenAt: { gte: since },
          components: { hasSome: issue.components },
        },
        select: { id: true },
        orderBy: { lastSeenAt: "desc" },
        take: 20,
      })
    : [];
  const ids = [...new Set([...byText, ...byComponent].map((r) => r.id))];
  return tx.issue.findMany({ where: { projectId: scope.projectId, id: { in: ids } } });
}

/**
 * Stage 3 for a new issue: stores the best lexical candidates above the
 * project's threshold as pending, never a pair a person already rejected
 * or decided. Returns the number stored. Changes no issue.
 */
export async function suggestDuplicates(tx: DbTx, scope: Scope, issue: IssueRow, actor: IssueActor) {
  const { settings } = await readIssuesSettings(tx, scope);
  const pool = await lexicalPool(tx, scope, issue);
  if (!pool.length) return 0;
  const decided = await tx.issueDuplicateCandidate.findMany({
    where: {
      projectId: scope.projectId,
      OR: [
        { issueId: issue.id, candidateIssueId: { in: pool.map((c) => c.id) } },
        { candidateIssueId: issue.id, issueId: { in: pool.map((c) => c.id) } },
      ],
    },
    select: { issueId: true, candidateIssueId: true },
  });
  const known = new Set(decided.flatMap((d) => [d.issueId, d.candidateIssueId]));
  const scored = pool
    .filter((c) => !known.has(c.id))
    .map((c) => ({ candidate: c, ...lexicalScore(issue, c) }))
    .filter((c) => c.score >= settings.dedupe.suggestThreshold)
    .sort((a, b) => b.score - a.score || b.candidate.reportCount - a.candidate.reportCount)
    .slice(0, MAX_CANDIDATES);
  for (const c of scored)
    await tx.issueDuplicateCandidate.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        issueId: issue.id,
        candidateIssueId: c.candidate.id,
        method: "lexical",
        score: c.score,
        reasons: c.reasons,
      },
    });
  if (scored.length)
    await issueEvent(tx, scope, issue.id, "duplicate_candidate", actor, {}, { method: "lexical", count: scored.length });
  return scored.length;
}

async function loadCandidate(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.issueDuplicateCandidate.findFirst({ where: { projectId: scope.projectId, id: uuid.parse(id) } });
  if (!row) throw new DomainError("ISSUES_NOT_FOUND", 404);
  if (row.status !== "pending") throw new DomainError("ISSUES_CANDIDATE_DECIDED", 409);
  return row;
}

const confirmInput = z
  .object({
    /** Which of the two survives; the candidate (older) issue by default. */
    keep: z.enum(["candidate", "issue"]).default("candidate"),
    expectedVersion: z.int().min(1),
  })
  .strict();

/**
 * A person confirms a candidate: the other issue is merged into the one
 * kept. `expectedVersion` is the merged issue's version.
 */
export async function confirmCandidate(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const input = confirmInput.parse(raw);
  const row = await loadCandidate(tx, scope, id);
  const [source, target] = input.keep === "candidate" ? [row.issueId, row.candidateIssueId] : [row.candidateIssueId, row.issueId];
  return mergeIssue(tx, scope, source, { targetIssueId: target, expectedVersion: input.expectedVersion }, actor);
}

/** A person rejects a candidate; the pair is never proposed again. */
export async function rejectCandidate(tx: DbTx, scope: Scope, id: string, actor: IssueActor) {
  const row = await loadCandidate(tx, scope, id);
  await tx.issueDuplicateCandidate.update({
    where: { id: row.id },
    data: { status: "rejected", decidedBy: actor.id ?? actor.kind, decidedAt: new Date() },
  });
  await issueEvent(tx, scope, row.issueId, "duplicate_candidate", actor, {}, { rejected: row.candidateIssueId });
  return { id: row.id, status: "rejected" as const };
}
