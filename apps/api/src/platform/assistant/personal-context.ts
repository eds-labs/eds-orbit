import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { redact } from "../privacy/redact.ts";
import { audit, create, data, DomainError, entity, list, update } from "../shared.ts";

// The personal context (ADR 0022 D-17): short, user-private notes the
// personal assistant may use, stored in the user's personal space. The
// assistant saves entries itself with a visible notice and an undo
// ("automatic memory"); a switch turns that into proposals the user saves.
// Every entry passes a deterministic screen first: no personal data of
// others, no secrets, no health or financial details. Entries never reach
// configured agents, work orders or MCP outputs: nothing outside this file
// and the personal-mode instructions reads the kind.

export const PERSONAL_CONTEXT_KIND = "personal_context";
export const ASSISTANT_SETTINGS_KIND = "assistant_settings";
/** At most this much active context enters one personal-mode prompt. */
export const PERSONAL_CONTEXT_PROMPT_BYTES = 2048;
export const PERSONAL_CONTEXT_MAX_ENTRIES = 200;

export const contextCategories = [
  "preference",
  "project_note",
  "decision",
  "workflow",
] as const;

const text = z.string().trim().min(3).max(500);
export const contextEntryInput = z
  .object({
    category: z.enum(contextCategories),
    text,
    projectId: z.uuid().nullable().optional(),
  })
  .strict();
export const contextEntryPatch = z
  .object({
    version: z.number().int().min(1),
    category: z.enum(contextCategories).optional(),
    text: text.optional(),
    projectId: z.uuid().nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict();
export const assistantSettingsInput = z
  .object({ autoMemory: z.boolean() })
  .strict();

export type ContextEntry = {
  id: string;
  version: number;
  category: (typeof contextCategories)[number];
  text: string;
  projectId: string | null;
  status: "active" | "archived";
  createdBy: "user" | "assistant" | "assistant_confirmed";
  source?: { conversationId: string; messageId?: string };
  createdAt: string;
};

// Health and financial details (D-17 guardrails), English and German. Words,
// not a classifier: a refusal is cheap to correct by rewording.
const HEALTH =
  /\b(diagnos\w*|illness|disease|disorder|symptom\w*|medication|medicine|prescri\w*|therap\w*|pregnan\w*|disabilit\w*|depress\w*|anxiety|cancer|diabet\w*|krankheit\w*|krank|erkrank\w*|medikament\w*|therapie\w*|schwanger\w*|behinderung\w*|arztbesuch\w*|psych\w*)\b/i;
const FINANCE =
  /\b(salary|income|net worth|credit score|debt|debts|loan|mortgage|bank account|account number|card number|tax id|gehalt|einkommen|kontostand|kontonummer|schulden|kredit|hypothek|steuernummer|steuer-id|vermögen)\b/i;
const CREDENTIAL = /\b(password|passwort|kennwort|pin|passcode|api[ -]?key|zugangsdaten|login daten)\b/i;

/**
 * The deterministic screen (D-17): refuses with PERSONAL_CONTEXT_NOT_ALLOWED
 * when the text holds contact or account data (e-mail, phone, IBAN, card,
 * IP, wallet), a secret or a credential word, or health or financial
 * details. Returns the reason for tests and logs, never the text.
 */
export function screenContextText(value: string): string | null {
  const { counts } = redact(value);
  const hit = Object.keys(counts).find((kind) => (counts as Record<string, number>)[kind]);
  if (hit) return hit;
  if (CREDENTIAL.test(value)) return "credential";
  if (HEALTH.test(value)) return "health";
  if (FINANCE.test(value)) return "financial";
  return null;
}

function assertAllowed(value: string) {
  const reason = screenContextText(value);
  if (reason) throw new DomainError("PERSONAL_CONTEXT_NOT_ALLOWED", 400);
}

const significant = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);

/**
 * Whether an entry the assistant wants to save rests on what the user said
 * in the turn (D-17: never on tool results): at least half of the entry's
 * significant words (four letters or more) occur in the user's message.
 */
export function groundedInUserText(entry: string, userText: string) {
  const words = significant(entry);
  if (!words.length) return false;
  const said = new Set(significant(userText));
  return words.filter((w) => said.has(w)).length * 2 >= words.length;
}

async function requirePersonal(tx: DbTx, scope: Scope) {
  const project = await tx.project.findFirst({
    where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: { kind: true, personalUserId: true },
  });
  if (project?.kind !== "personal" || project.personalUserId !== scope.userId)
    throw new DomainError("NOT_FOUND", 404);
}

function view(row: { id: string; version: number; data: unknown; createdAt: Date }): ContextEntry {
  const d = data(row) as Omit<ContextEntry, "id" | "version" | "createdAt">;
  return {
    id: row.id,
    version: row.version,
    category: d.category,
    text: d.text,
    projectId: d.projectId ?? null,
    status: d.status,
    createdBy: d.createdBy,
    ...(d.source ? { source: d.source } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The user's entries, newest first. */
export async function listContext(tx: DbTx, scope: Scope): Promise<ContextEntry[]> {
  await requirePersonal(tx, scope);
  return (await list(tx, scope, PERSONAL_CONTEXT_KIND)).map(view);
}

/** Whether the assistant saves entries itself (default) or proposes them. */
export async function readAssistantSettings(tx: DbTx, scope: Scope) {
  await requirePersonal(tx, scope);
  const row = (await list(tx, scope, ASSISTANT_SETTINGS_KIND))[0];
  return { autoMemory: row ? data(row).autoMemory !== false : true };
}

export async function saveAssistantSettings(tx: DbTx, scope: Scope, raw: unknown) {
  await requirePersonal(tx, scope);
  const input = assistantSettingsInput.parse(raw);
  const row = (await list(tx, scope, ASSISTANT_SETTINGS_KIND))[0];
  if (row) await update(tx, scope, row, { ...data(row), ...input });
  else await create(tx, scope, ASSISTANT_SETTINGS_KIND, input);
  await audit(tx, scope, "assistant.settings_changed", scope.projectId, input);
  return input;
}

/**
 * Saves an entry: written by the user, by the assistant (automatic memory)
 * or confirmed from an assistant proposal. Screened first; at most
 * PERSONAL_CONTEXT_MAX_ENTRIES active entries.
 */
export async function addContext(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  createdBy: ContextEntry["createdBy"] = "user",
  source?: ContextEntry["source"],
): Promise<ContextEntry> {
  await requirePersonal(tx, scope);
  const input = contextEntryInput.parse(raw);
  assertAllowed(input.text);
  const active = (await list(tx, scope, PERSONAL_CONTEXT_KIND)).filter(
    (row) => data(row).status === "active",
  );
  if (active.length >= PERSONAL_CONTEXT_MAX_ENTRIES)
    throw new DomainError("PERSONAL_CONTEXT_FULL", 409);
  const row = await create(tx, scope, PERSONAL_CONTEXT_KIND, {
    category: input.category,
    text: input.text,
    projectId: input.projectId ?? null,
    status: "active",
    createdBy,
    ...(source ? { source } : {}),
  });
  // Content-free audit: who added which entry, never its text.
  await audit(tx, scope, "personal_context.added", row.id, { createdBy, category: input.category });
  return view(row);
}

export async function patchContext(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  await requirePersonal(tx, scope);
  const input = contextEntryPatch.parse(raw);
  const row = await entity(tx, scope, PERSONAL_CONTEXT_KIND, id);
  if (row.version !== input.version) throw new DomainError("VERSION_CONFLICT", 409);
  if (input.text !== undefined) assertAllowed(input.text);
  const { version: _version, ...fields } = input;
  const next = { ...data(row), ...fields };
  const saved = await update(tx, scope, row, next);
  await audit(tx, scope, "personal_context.changed", row.id, {
    fields: Object.keys(fields).sort(),
  });
  return view(saved);
}

/** Deletes an entry with every stored version of its text. */
export async function deleteContext(tx: DbTx, scope: Scope, id: string) {
  await requirePersonal(tx, scope);
  const row = await entity(tx, scope, PERSONAL_CONTEXT_KIND, id);
  await tx.entityVersion.deleteMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, entityId: row.id },
  });
  await tx.entity.delete({ where: { id: row.id } });
  await audit(tx, scope, "personal_context.deleted", row.id, {});
  return { deleted: true };
}

/** Everything the user stored, for the JSON download. */
export async function exportContext(tx: DbTx, scope: Scope) {
  return {
    exportedAt: new Date().toISOString(),
    settings: await readAssistantSettings(tx, scope),
    entries: await listContext(tx, scope),
  };
}

/**
 * The entries a personal-mode prompt includes: active ones, those with a
 * project only while that project is the focus or named in the turn,
 * newest first, within PERSONAL_CONTEXT_PROMPT_BYTES.
 */
export function contextForPrompt(
  entries: readonly ContextEntry[],
  projectsInTurn: ReadonlySet<string>,
) {
  const picked: ContextEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    if (entry.projectId && !projectsInTurn.has(entry.projectId)) continue;
    const line = `- (${entry.category}) ${entry.text}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > PERSONAL_CONTEXT_PROMPT_BYTES) break;
    bytes += size;
    picked.push(entry);
  }
  return picked;
}
