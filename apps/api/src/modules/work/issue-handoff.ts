import { z } from "zod";
import type { HandoffTarget } from "../../platform/handoffs/types.ts";
import { createLink } from "../../platform/links/links.ts";
import type { WorkActor } from "./common.ts";
import { requireWork } from "./gate.ts";
import { WORK_WRITE } from "./permissions.ts";
import { createTask } from "./tasks.ts";

// A task from an issue (ADR 0018, plan §2.6): the issue center hands in
// the issue's redacted, curated fields; the task links to the issue with
// `implements`, so the issue follows the task's progress. Work never reads
// the issue itself and never changes it.

const input = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000).optional(),
    initiativeId: z.uuid().optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  })
  .strict();

export const taskFromIssue: HandoffTarget = {
  label: { en: "Development task", de: "Entwicklungsaufgabe" },
  accepts: ["issues.issue"],
  permission: WORK_WRITE,
  risk: "W0_internal",
  input,
  async create(tx, scope, from, raw, actor) {
    await requireWork(tx, scope);
    const brief = input.parse(raw);
    const task = await createTask(tx, scope, brief, actor as WorkActor, "issue");
    await createLink(tx, scope, { source: { type: "work.task", id: task.id }, target: from, relation: "implements" }, actor);
    return { target: { type: "work.task", id: task.id } };
  },
};
