import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { createPackageProject } from "./package-project.ts";

/**
 * A synthetic project for the AI project manager (ADR 0017): the content
 * package project's members, spend mandate and synthetic AI routes, plus
 * the work module enabled. No test reaches a provider.
 */
export async function createWorkPmProject(options: { name?: string } = {}) {
  const project = await createPackageProject({ name: options.name ?? "Synthetic work PM" });
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, fn);
  await run((tx) =>
    tx.projectModule.create({
      data: {
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        moduleId: "work",
        enabled: true,
        moduleVersion: "1.0.0",
        changedBy: project.owner.userId,
      },
    }),
  );
  return { ...project, run, as: (s: Scope) => ({ kind: "user" as const, id: s.userId }) };
}

/** Sets the given environment switches for a suite and restores them after. */
export function withEnv(values: Record<string, string>) {
  const previous: Record<string, string | undefined> = {};
  return {
    apply() {
      for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key];
        process.env[key] = value;
      }
    },
    restore() {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    },
  };
}
