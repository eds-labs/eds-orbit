import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createInitiative, setInitiativeArchived } from "../src/modules/work/initiatives.ts";
import { pmActive } from "../src/modules/work/gate.ts";
import { readWorkSettings, saveWorkSettings } from "../src/modules/work/settings.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { defaultPmSettings } from "../src/modules/work/pm/settings-schema.ts";
import { getPmState, setPmState } from "../src/modules/work/pm/state.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** PM settings and per-initiative state (ADR 0017, WP2.2). */
describe.skipIf(!enabled)("AI project manager settings", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({ ORBIT_WORK: "true" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("is on only with both switches and the module in the project", async () => {
    expect(await p.run((tx) => pmActive(tx, p.owner))).toBe(false);
    process.env.ORBIT_WORK_PM = "true";
    try {
      expect(await p.run((tx) => pmActive(tx, p.owner))).toBe(true);
      process.env.ORBIT_WORK = "false";
      expect(await p.run((tx) => pmActive(tx, p.owner))).toBe(false);
    } finally {
      process.env.ORBIT_WORK = "true";
      delete process.env.ORBIT_WORK_PM;
    }
  });

  it("defaults to propose-only with USD 2 a day and keeps its part out of the general settings", async () => {
    const read = await p.run((tx) => readPmSettings(tx, p.owner));
    expect(read.settings).toEqual(defaultPmSettings());
    expect(read.settings.dailyCeilingMicros).toBe(2_000_000);
    const repository = {
      key: "orbit",
      label: "Orbit",
      provider: "github" as const,
      fullName: "eds-labs/eds-orbit",
      defaultBranch: "main",
      dispatch: { kind: "manual" as const },
    };
    const saved = await p.run((tx) =>
      savePmSettings(tx, p.owner, { ...read.settings, dailyCeilingMicros: 500_000, repositories: [repository] }, read.version),
    );
    expect(saved.settings.repositories).toEqual([repository]);
    // The general settings route cannot change the PM part.
    const general = await p.run((tx) => readWorkSettings(tx, p.owner));
    await p.run((tx) =>
      saveWorkSettings(
        tx,
        p.owner,
        { ...general.settings, pm: { ...general.settings.pm, dailyCeilingMicros: 90_000_000 } },
        general.version,
        new Set(),
        p.as(p.owner),
      ),
    );
    expect((await p.run((tx) => readPmSettings(tx, p.owner))).settings.dailyCeilingMicros).toBe(500_000);
    // A stale version and an unknown automation binding are refused.
    expect(await failure(p.run((tx) => savePmSettings(tx, p.owner, saved.settings, saved.version)))).toBe(
      "SETTINGS_VERSION_CONFLICT",
    );
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    expect(
      await failure(
        p.run((tx) =>
          savePmSettings(
            tx,
            p.owner,
            { ...current.settings, repositories: [{ ...repository, dispatch: { kind: "automation", bindingId: randomUUID() } }] },
            current.version,
          ),
        ),
      ),
    ).toBe("WORK_PM_BINDING_UNKNOWN");
  });

  it("keeps the PM off per initiative until enabled, with versioned changes", async () => {
    const initiative = await p.run((tx) => createInitiative(tx, p.owner, { title: "Marketplace launch" }, p.as(p.owner)));
    const initial = await p.run((tx) => getPmState(tx, p.owner, initiative.id));
    expect(initial).toMatchObject({
      enabled: false,
      settings: { reportSchedule: "off", research: "knowledge", escalateTo: [] },
      version: 0,
    });
    const on = await p.run((tx) =>
      setPmState(tx, p.owner, initiative.id, { expectedVersion: 0, enabled: true, settings: { reportSchedule: "weekly" } }),
    );
    expect(on).toMatchObject({ enabled: true, settings: { reportSchedule: "weekly", research: "knowledge" }, version: 1 });
    expect(await failure(p.run((tx) => setPmState(tx, p.owner, initiative.id, { expectedVersion: 0, enabled: false })))).toBe(
      "WORK_VERSION_CONFLICT",
    );
    // Escalation goes to people who work in the module, never to viewers.
    expect(
      await failure(
        p.run((tx) =>
          setPmState(tx, p.owner, initiative.id, { expectedVersion: 1, settings: { escalateTo: [p.viewer.userId] } }),
        ),
      ),
    ).toBe("WORK_ASSIGNEE_INVALID");
    const escalated = await p.run((tx) =>
      setPmState(tx, p.owner, initiative.id, { expectedVersion: 1, settings: { escalateTo: [p.editor.userId] } }),
    );
    expect(escalated.settings).toMatchObject({ reportSchedule: "weekly", escalateTo: [p.editor.userId] });
    const audits = await p.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "work.pm.state_saved" } }),
    );
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain(p.editor.userId);
    // An archived initiative cannot be switched on.
    const archived = await p.run((tx) => createInitiative(tx, p.owner, { title: "Old" }, p.as(p.owner)));
    await p.run((tx) => setInitiativeArchived(tx, p.owner, archived.id, { expectedVersion: archived.version }, true, p.as(p.owner)));
    expect(await failure(p.run((tx) => setPmState(tx, p.owner, archived.id, { expectedVersion: 0, enabled: true })))).toBe(
      "WORK_INITIATIVE_ARCHIVED",
    );
  });
});
