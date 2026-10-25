import { z } from "zod";
import { dateInput } from "../common.ts";
import { PRIORITIES } from "../tasks.ts";

// The plan the PM proposes (ADR 0017, plan §2.4). The same strict schema
// is the model's output format and the stored, editable proposal. String
// lengths are refinements: the model-facing JSON schema of strict mode
// cannot express them, so they are checked here after the answer.

const text = (max: number) =>
  z.string().refine((v) => v.trim().length > 0 && v.length <= max, `1 to ${max} characters`);
const optionalText = (max: number) => z.string().refine((v) => v.length <= max, `at most ${max} characters`);

export const WORKSTREAM_REF = /^ws[0-9]{1,2}$/;
export const MILESTONE_REF = /^m[0-9]{1,2}$/;
export const TASK_REF = /^t[0-9]{1,3}$/;
export const PLAN_LIMITS = { tasks: 80, milestones: 15, workstreams: 10 } as const;

export const planTaskSchema = z
  .object({
    ref: z.string().regex(TASK_REF),
    title: text(300),
    description: optionalText(4000),
    workstreamRef: z.string().regex(WORKSTREAM_REF).nullable(),
    milestoneRef: z.string().regex(MILESTONE_REF).nullable(),
    /** A subtask's parent; subtasks are one level deep. */
    parentRef: z.string().regex(TASK_REF).nullable(),
    priority: z.enum(PRIORITIES),
    estimate: z.int().min(0).max(1000).nullable(),
    dueDate: dateInput.nullable(),
    suggestedRole: optionalText(60).nullable(),
    /** A member id from the context's member list, or null; never invented. */
    suggestedAssigneeUserId: optionalText(100).nullable(),
    acceptanceCriteria: z.array(text(300)).max(10),
    /** Refs of tasks that must finish first. */
    dependsOn: z.array(z.string().regex(TASK_REF)).max(20),
  })
  .strict();

export const workPlanSchema = z
  .object({
    goal: text(1000),
    scope: z
      .object({ in: z.array(text(300)).max(15), out: z.array(text(300)).max(15) })
      .strict(),
    initiative: z
      .object({
        title: text(200),
        key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).nullable(),
        startDate: dateInput.nullable(),
        targetDate: dateInput.nullable(),
      })
      .strict(),
    workstreams: z
      .array(
        z
          .object({ ref: z.string().regex(WORKSTREAM_REF), title: text(200), summary: optionalText(500) })
          .strict(),
      )
      .max(PLAN_LIMITS.workstreams),
    milestones: z
      .array(
        z
          .object({
            ref: z.string().regex(MILESTONE_REF),
            title: text(200),
            dueDate: dateInput.nullable(),
            criteria: optionalText(500),
          })
          .strict(),
      )
      .max(PLAN_LIMITS.milestones),
    tasks: z.array(planTaskSchema).min(1).max(PLAN_LIMITS.tasks),
    risks: z
      .array(
        z
          .object({
            title: text(200),
            impact: z.enum(["low", "medium", "high"]),
            mitigation: optionalText(500),
          })
          .strict(),
      )
      .max(15),
    openDecisions: z
      .array(
        z
          .object({
            question: text(300),
            options: z.array(text(200)).max(5),
            recommendation: optionalText(300).nullable(),
          })
          .strict(),
      )
      .max(15),
    assumptions: z.array(text(300)).max(15),
  })
  .strict();
export type WorkPlan = z.infer<typeof workPlanSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
