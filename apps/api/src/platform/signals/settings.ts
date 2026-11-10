import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, list, update } from "../shared.ts";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import {
  ownerEnabled,
  registeredSignals,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { proactiveEnabled } from "../proactive/preferences.ts";

// Per-project signal switches (ADR 0023, plan §2.2 "Signals can be disabled
// per project in the platform settings"). A project entity `signal_settings`
// lists the detectors that are off; everything else is on. Mappings of
// existing notices are not switched here: their kinds keep the members'
// own per-kind choices.

export const SIGNAL_SETTINGS_KIND = "signal_settings";

const detector = (s: { source: object }) => "event" in s.source || "periodic" in s.source;

async function stored(tx: DbTx, scope: Pick<Scope, "workspaceId" | "projectId">) {
  const row = (await list(tx, scope as Scope, SIGNAL_SETTINGS_KIND))[0];
  const off = Array.isArray(data(row).off) ? (data(row).off as string[]) : [];
  return { row: row ?? null, off: new Set(off) };
}

/** Whether a detector is switched off in the project. */
export async function signalSwitchedOff(tx: DbTx, scope: Scope, key: string) {
  return (await stored(tx, scope)).off.has(key);
}

async function requireBusiness(tx: DbTx, scope: Scope) {
  if (!proactiveEnabled()) throw new DomainError("NOT_FOUND", 404);
  const project = await tx.project.findFirst({
    where: { id: scope.projectId },
    select: { kind: true },
  });
  if (!project || project.kind === "personal") throw new DomainError("NOT_FOUND", 404);
}

/** The signals of the project's enabled modules with their switch. */
export async function listSignalSettings(tx: DbTx, scope: Scope) {
  await requireBusiness(tx, scope);
  const enabled = await enabledModules(tx, scope);
  const { off } = await stored(tx, scope);
  return {
    mayEdit: scope.role === "owner",
    signals: registeredSignals()
      .filter((s) => ownerEnabled(s.owner, enabled))
      .map((s) => ({
        key: s.key,
        moduleId: s.owner,
        kind: s.kind,
        title: s.title,
        source: "event" in s.source ? "event" : "periodic" in s.source ? "periodic" : "mapping",
        switchable: detector(s),
        on: !detector(s) || !off.has(s.key),
      })),
  };
}

const settingsInput = z.strictObject({
  signals: z
    .record(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/), z.boolean())
    .refine((v) => Object.keys(v).length <= 100),
});

/** Owner only: switches detectors on or off; unknown keys are refused. */
export async function saveSignalSettings(tx: DbTx, scope: Scope, raw: unknown) {
  await requireBusiness(tx, scope);
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = settingsInput.parse(raw);
  const known = new Map(registeredSignals().filter(detector).map((s) => [s.key, s]));
  for (const key of Object.keys(input.signals))
    if (!known.has(key)) throw new DomainError("SIGNAL_UNKNOWN", 400);
  const { row, off } = await stored(tx, scope);
  for (const [key, on] of Object.entries(input.signals))
    if (on) off.delete(key);
    else off.add(key);
  const value = { off: [...off].sort() };
  if (row) await update(tx, scope, row, value);
  else await create(tx, scope, SIGNAL_SETTINGS_KIND, value);
  await audit(tx, scope, "signals.settings_changed", scope.projectId, value);
  return listSignalSettings(tx, scope);
}

/** Runs a settings call in the project's transaction. */
export const inProject = <T>(scope: Scope, work: (tx: DbTx) => Promise<T>) =>
  scoped(scope.workspaceId, scope.projectId, work);
