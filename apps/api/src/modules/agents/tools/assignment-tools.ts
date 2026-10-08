import { z } from "zod";
import { chatScoped } from "../../chat.ts";
import type { AssignmentCard, ChatCard } from "../../chat-tools.ts";
import { zonedTime } from "../../posting-slots.ts";
import { data, DomainError, entity, list } from "../../../shared.ts";
import {
  proposeAssignment,
  setAssignmentStatus,
  updateAssignment,
} from "../assignments.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

/**
 * Orbit Core's tools for assignments. Every server ruling (OWNER_REQUIRED,
 * VERSION_CONFLICT, ASSIGNMENT_BUDGET_EXCEEDS_PROJECT, ...) reaches the model
 * as `{ error: code }`; invalid input as ASSIGNMENT_VALIDATION_FAILED with the
 * invalid fields (chat-runner). The server validates everything again.
 */

// Model-facing shapes only: strict mode has no defaults or length limits, so
// optional fields are nullable and `assignmentInput` stays authoritative.
const schedule = z
  .object({
    rhythm: z.enum(["daily", "weekly", "once"]),
    weekdays: z
      .array(z.number().int())
      .describe("Weekly only: 0 = Sunday to 6; otherwise []"),
    times: z.array(z.string()).describe("Local HH:MM in the project timezone"),
    date: z.string().nullable().describe("One-off only: local YYYY-MM-DD"),
    leadMinutes: z
      .number()
      .int()
      .nullable()
      .describe("Preparation lead before the slot; 360 when null"),
  })
  .strict();
const kind = z.enum(["one_off", "standing"]);
const contentType = z.enum(["social", "blog", "newsletter", "report"]);

const proposeParameters = z
  .object({
    name: z.string(),
    kind,
    schedule,
    contentType,
    channels: z
      .array(z.string())
      .describe(
        "Policy channel IDs from project_status; [] for a report, which is never published",
      ),
    topicFrame: z
      .string()
      .describe("What the posts are about, in the user's words"),
    tone: z.string().nullable(),
    image: z
      .boolean()
      .describe(
        "Whether each run gets an image; the owner must accept image rights",
      ),
    styleAssetIds: z
      .array(z.string())
      .describe("Approved asset IDs the images should look like; [] if none"),
    vetoMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Minutes the owner can stop a post before its slot; 180 when null",
      ),
    monthlyBudgetMicros: z
      .number()
      .int()
      .describe("USD millionths per month, within the project's model budget"),
  })
  .strict();

const changeParameters = z
  .object({
    assignmentId: z.string(),
    version: z
      .number()
      .int()
      .nullable()
      .describe("From assignment_list or its card; required for action change"),
    action: z.enum(["pause", "resume", "change"]),
    changes: z
      .object({
        name: z.string().nullable(),
        kind: kind.nullable(),
        schedule: schedule
          .nullable()
          .describe("The whole schedule, also the parts that stay the same"),
        contentType: contentType.nullable(),
        channels: z.array(z.string()).nullable(),
        topicFrame: z.string().nullable(),
        tone: z.string().nullable(),
        image: z.boolean().nullable(),
        styleAssetIds: z.array(z.string()).nullable(),
        vetoMinutes: z.number().int().nullable(),
        monthlyBudgetMicros: z.number().int().nullable(),
      })
      .strict()
      .nullable()
      .describe("Only for action change; leave unchanged fields null"),
  })
  .strict();

const label = (text: string, name: unknown) =>
  `${text}: ${String(name ?? "").slice(0, 120)}`;

/** The card Task 14 renders: the draft as shown to the owner and the request to decide. */
export function assignmentCardOf(row: {
  id: string;
  version: number;
  data: unknown;
}): AssignmentCard {
  const d = data(row);
  const { rhythm, weekdays, times, date, leadMinutes } = d.schedule;
  return {
    id: row.id,
    version: row.version,
    name: d.name,
    status: d.status,
    kind: d.kind,
    contentType: d.contentType,
    channels: d.channels,
    schedule: {
      rhythm,
      weekdays,
      times,
      ...(date ? { date } : {}),
      leadMinutes,
    },
    topicFrame: d.topicFrame,
    ...(d.tone ? { tone: d.tone } : {}),
    image: d.image,
    styleAssetIds: d.styleAssetIds,
    vetoMinutes: d.vetoMinutes,
    monthlyBudgetMicros: d.monthlyBudgetMicros,
    actionRequestId: d.status === "draft" ? (d.actionRequestId ?? null) : null,
  };
}

const confirmationCard = (
  row: Parameters<typeof assignmentCardOf>[0],
): ChatCard => ({
  kind: "assignment",
  label: label("Assignment awaiting confirmation", data(row).name),
  status: "confirmation_required",
  assignment: assignmentCardOf(row),
});

/** Local calendar date as YYYY-MM-DD. */
const localKey = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
function localDay(at: Date, timezone: string) {
  const [y, m, d] = localKey(at, timezone).split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}
const dayKey = (day: Date) => day.toISOString().slice(0, 10);

/** Next slot of an active schedule as local "YYYY-MM-DD HH:MM", or null. */
function nextSlotLocal(
  schedule: Record<string, any>,
  timezone: string,
  now: Date,
) {
  const today = localDay(now, timezone);
  const days =
    schedule.rhythm === "once"
      ? [new Date(`${schedule.date}T00:00:00Z`)]
      : Array.from(
          { length: 8 },
          (_, offset) =>
            new Date(Date.UTC(today.y, today.m - 1, today.d + offset)),
        );
  for (const day of days) {
    if (
      schedule.rhythm === "weekly" &&
      !schedule.weekdays.includes(day.getUTCDay())
    )
      continue;
    for (const time of schedule.times as string[]) {
      const [hh, mm] = time.split(":").map(Number);
      const at = zonedTime(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        hh!,
        mm!,
        timezone,
      );
      if (at > now) return `${dayKey(day)} ${time}`;
    }
  }
  return null;
}

export const assignmentTools: readonly OrbitTool[] = [
  defineTool({
    name: "assignment_propose",
    namespace: "assignments",
    description:
      "Propose a standing or one-off assignment (e.g. two posts a day); the owner confirms its card. Nothing runs or is published before that.",
    parameters: proposeParameters,
    risk: "P_proposal",
    roles: ["editor", "owner"],
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { assignment, actionRequest } = await proposeAssignment(
        context.scope,
        context.conversationId,
        dropNullFields(args),
      );
      return {
        output: {
          assignmentId: assignment.id,
          version: assignment.version,
          status: "awaiting_confirmation",
          actionRequestId: actionRequest.id,
        },
        cards: [confirmationCard(assignment)],
      };
    },
  }),
  defineTool({
    name: "assignment_list",
    namespace: "assignments",
    description:
      "Assignments with status, next slot and this month's cost. Report assignments only from this tool.",
    parameters: z.object({}).strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "agents",
    deferLoading: true,
    async execute(context) {
      const now = new Date();
      const listed = await chatScoped(context.scope, async (tx) => {
        const project = await tx.project.findUniqueOrThrow({
          where: { id: context.scope.projectId },
        });
        return {
          timezone: project.timezone,
          assignments: await list(tx, context.scope, "assignments"),
          runs: await list(tx, context.scope, "assignment_runs"),
        };
      });
      const month = localKey(now, listed.timezone).slice(0, 7);
      return {
        output: {
          timezone: listed.timezone,
          assignments: listed.assignments.slice(0, 20).map((row) => {
            const d = data(row);
            return {
              id: row.id,
              name: d.name,
              status: d.status,
              version: row.version,
              kind: d.kind,
              contentType: d.contentType,
              channels: d.channels,
              times: d.schedule.times,
              nextSlotLocal:
                d.status === "active"
                  ? nextSlotLocal(d.schedule, listed.timezone, now)
                  : null,
              // Runs record their cost per local date (assignment-runs.ts).
              monthCostMicros: listed.runs
                .filter(
                  (run) =>
                    data(run).assignmentId === row.id &&
                    String(data(run).date ?? "").startsWith(month),
                )
                .reduce(
                  (sum, run) => sum + Number(data(run).costMicros ?? 0),
                  0,
                ),
              monthlyBudgetMicros: d.monthlyBudgetMicros,
              pendingActionRequestId:
                d.status === "draft" ? (d.actionRequestId ?? null) : null,
            };
          }),
        },
        cards: [],
      };
    },
  }),
  defineTool({
    name: "assignment_change",
    namespace: "assignments",
    description:
      "Pause or resume an assignment (resume: owner), or change it. Moving times is the owner's; any other change returns it to draft for a new confirmation.",
    parameters: changeParameters,
    risk: "P_proposal",
    roles: ["editor", "owner"],
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const input = changeParameters.parse(args);
      const patch = dropNullFields(input.changes ?? {}) as Record<
        string,
        unknown
      >;
      if (input.action === "change") {
        if (input.version === null)
          throw new DomainError("ASSIGNMENT_VERSION_REQUIRED", 400);
        if (!Object.keys(patch).length)
          throw new DomainError("ASSIGNMENT_CHANGE_EMPTY", 400);
      }
      const { before, after } = await chatScoped(context.scope, async (tx) => {
        const row = await entity(
          tx,
          context.scope,
          "assignments",
          input.assignmentId,
        );
        return {
          before: row,
          after:
            input.action === "change"
              ? await updateAssignment(
                  tx,
                  context.scope,
                  row.id,
                  input.version!,
                  patch,
                )
              : await setAssignmentStatus(
                  tx,
                  context.scope,
                  row.id,
                  input.action === "pause" ? "paused" : "active",
                ),
        };
      });
      const d = data(after);
      const confirmationRequired = d.status === "draft";
      const name = d.name;
      const cards: ChatCard[] = [];
      if (after.version !== before.version)
        cards.push(
          confirmationRequired
            ? confirmationCard(after)
            : {
                kind: "status",
                label: label(
                  input.action === "pause"
                    ? "Assignment paused"
                    : input.action === "resume"
                      ? "Assignment resumed"
                      : "Assignment times updated",
                  name,
                ),
                status: d.status,
              },
        );
      return {
        output: {
          assignmentId: after.id,
          version: after.version,
          status: confirmationRequired ? "awaiting_confirmation" : d.status,
          confirmationRequired,
          actionRequestId: confirmationRequired
            ? (d.actionRequestId ?? null)
            : null,
        },
        cards,
      };
    },
  }),
  defineTool({
    name: "run_status",
    namespace: "assignments",
    description:
      "Today's assignment runs: state, steps, cost, deliverables and vetoes. Report runs only from this tool.",
    parameters: z
      .object({
        assignmentId: z
          .string()
          .nullable()
          .describe("All assignments when null"),
      })
      .strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { assignmentId } = z
        .object({ assignmentId: z.string().nullable() })
        .strict()
        .parse(args);
      const found = await chatScoped(context.scope, async (tx) => {
        const project = await tx.project.findUniqueOrThrow({
          where: { id: context.scope.projectId },
        });
        return {
          timezone: project.timezone,
          assignments: await list(tx, context.scope, "assignments"),
          runs: await list(tx, context.scope, "assignment_runs"),
        };
      });
      const date = localKey(new Date(), found.timezone);
      const names = new Map(
        found.assignments.map((row) => [row.id, data(row).name]),
      );
      // Run data follows the plan of assignment-runs.ts: date, status, steps, costMicros.
      const runs = found.runs
        .filter(
          (run) =>
            data(run).date === date &&
            (assignmentId === null || data(run).assignmentId === assignmentId),
        )
        .slice(0, 20)
        .map((run) => {
          const d = data(run);
          return {
            id: run.id,
            assignmentId: d.assignmentId,
            assignmentName: names.get(d.assignmentId) ?? null,
            date: d.date,
            status: d.status,
            costMicros: Number(d.costMicros ?? 0),
            steps: (Array.isArray(d.steps) ? d.steps : []).map((step: any) => ({
              key: step.key,
              role: step.role,
              status: step.status,
            })),
            deliverables: Array.isArray(d.deliverables)
              ? d.deliverables.slice(0, 10)
              : [],
            vetoes: Array.isArray(d.vetoes) ? d.vetoes.slice(0, 10) : [],
          };
        });
      return { output: { date, runs }, cards: [] };
    },
  }),
];
