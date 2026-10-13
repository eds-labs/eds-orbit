import type { ValidatedRegistry } from "../../../../../packages/module-contracts/src/index.ts";
import type { OrbitTool } from "../../modules/agents/tools/registry.ts";
import type { ActionDefinition } from "../../modules/action-requests.ts";
import type {
  JobDef,
  PeriodicTask,
  SchedulerContribution,
} from "../jobs/types.ts";
import type {
  ProjectHooks,
  RetentionContribution,
} from "../governance/types.ts";

/**
 * What a module plugs into the platform's registries (WP1.6). The platform
 * never imports a module; the composition roots (API, worker, test setup)
 * register every module's contributions once at startup.
 */
export type ModuleContributions = {
  /** Assistant tools, in the order they are offered. */
  tools?: readonly OrbitTool[];
  /** Action request types (ADR 0008), keyed by type name. */
  actionTypes?: Readonly<Record<string, ActionDefinition<any>>>;
  /** Worker queue classes. */
  jobs?: readonly JobDef[];
  /** The module's part of the per-project sweep. */
  scheduler?: SchedulerContribution;
  /** Client projections of the module's entity kinds (secrets stripped). */
  publicViews?: Readonly<Record<string, (row: any) => any>>;
  /** Steps of a project pause and resume (WP1.8). */
  hooks?: ProjectHooks;
  /** The module's part of the retention action (WP1.8). */
  retention?: RetentionContribution;
  /** Per-project work the worker runs after dispatching jobs (WP2.1). */
  periodic?: readonly PeriodicTask[];
  /** Called once when the worker starts, after registration (WP2.1). */
  onWorkerStart?: () => void;
};

type Registered = {
  registry: ValidatedRegistry;
  byModule: ReadonlyMap<string, ModuleContributions>;
  tools: readonly OrbitTool[];
  actionTypes: ReadonlyMap<string, ActionDefinition<any>>;
  jobs: ReadonlyMap<string, JobDef>;
  publicViews: ReadonlyMap<string, (row: any) => any>;
  periodic: readonly PeriodicTask[];
};
let registered: Registered | null = null;

/**
 * Registers the platform's own and every module's contributions. Names must
 * be unique; a module may only project the entity kinds it owns. Registering
 * the same registry again is a no-op (test setup and buildServer both do).
 */
export function registerContributions(
  registry: ValidatedRegistry,
  platform: ModuleContributions,
  modules: Readonly<Record<string, ModuleContributions>>,
) {
  if (registered?.registry === registry) return;
  const problems: string[] = [];
  const ordered: [string, ModuleContributions][] = [
    ["platform", platform],
    ...registry.order.map(
      (id) => [id, modules[id] ?? {}] as [string, ModuleContributions],
    ),
  ];
  for (const id of Object.keys(modules))
    if (!registry.order.includes(id))
      problems.push(`contributions for unknown module ${id}`);
  const tools: OrbitTool[] = [];
  const actionTypes = new Map<string, ActionDefinition<any>>();
  const jobs = new Map<string, JobDef>();
  const publicViews = new Map<string, (row: any) => any>();
  const periodic: PeriodicTask[] = [];
  for (const [owner, c] of ordered) {
    for (const task of c.periodic ?? []) {
      if (periodic.some((t) => t.name === task.name))
        problems.push(`periodic task ${task.name} registered twice`);
      periodic.push(task);
    }
    for (const tool of c.tools ?? []) {
      if (tools.some((t) => t.name === tool.name))
        problems.push(`tool ${tool.name} registered twice`);
      tools.push(tool);
    }
    for (const [type, def] of Object.entries(c.actionTypes ?? {})) {
      if (actionTypes.has(type))
        problems.push(`action type ${type} registered twice`);
      actionTypes.set(type, def);
    }
    for (const job of c.jobs ?? []) {
      if (jobs.has(job.queueClass))
        problems.push(`queue class ${job.queueClass} registered twice`);
      jobs.set(job.queueClass, job);
    }
    for (const [kind, view] of Object.entries(c.publicViews ?? {})) {
      if ((registry.kindOwner.get(kind) ?? null) !== owner)
        problems.push(`${owner} projects entity kind ${kind} it does not own`);
      publicViews.set(kind, view);
    }
  }
  if (problems.length)
    throw new Error(`MODULE_CONTRIBUTIONS_INVALID: ${problems.join("; ")}`);
  registered = {
    registry,
    byModule: new Map(ordered),
    tools,
    actionTypes,
    jobs,
    publicViews,
    periodic,
  };
}

function current(): Registered {
  // Fail closed: without registration no tool, action type, job or
  // projection silently disappears.
  if (!registered) throw new Error("MODULE_CONTRIBUTIONS_NOT_REGISTERED");
  return registered;
}

/** Assistant tools of every module, platform first, then in registry order. */
export function registeredTools(): readonly OrbitTool[] {
  return current().tools;
}
export function registeredActionType(type: string) {
  return current().actionTypes.get(type);
}
export function registeredJobs(): ReadonlyMap<string, JobDef> {
  return current().jobs;
}
/**
 * Scheduler contributions in the order the sweep ran before WP1.6: modules in
 * dependency order, then the platform (periodic source sync).
 */
export function registeredSchedulers(): SchedulerContribution[] {
  const all = [...current().byModule.entries()];
  return [
    ...all.filter(([id]) => id !== "platform"),
    ...all.filter(([id]) => id === "platform"),
  ]
    .map(([, c]) => c.scheduler)
    .filter((s): s is SchedulerContribution => Boolean(s));
}
export function registeredPublicView(kind: string) {
  return current().publicViews.get(kind);
}

/** Pause and resume hooks: platform first, then modules in registry order. */
export function registeredHooks(): ProjectHooks[] {
  return [...current().byModule.values()]
    .map((c) => c.hooks)
    .filter((h): h is ProjectHooks => Boolean(h));
}
/** Retention contributions, in the same order as the hooks. */
export function registeredRetention(): RetentionContribution[] {
  return [...current().byModule.values()]
    .map((c) => c.retention)
    .filter((r): r is RetentionContribution => Boolean(r));
}
/** Entity kinds the project export leaves out (declared `exported: false`). */
export function unexportedKinds(): readonly string[] {
  return current().registry.unexportedKinds;
}

/** Periodic worker tasks: platform first, then modules in registry order. */
export function registeredPeriodicTasks(): readonly PeriodicTask[] {
  return current().periodic;
}
export function registeredPeriodicTask(name: string) {
  return current().periodic.find((t) => t.name === name);
}
/** Worker start hooks, in the same order. */
export function workerStartHooks(): Array<() => void> {
  return [...current().byModule.values()]
    .map((c) => c.onWorkerStart)
    .filter((h): h is () => void => Boolean(h));
}
