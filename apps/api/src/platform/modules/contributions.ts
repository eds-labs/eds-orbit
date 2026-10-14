import type { ValidatedRegistry } from "../../../../../packages/module-contracts/src/index.ts";
import type { OrbitTool } from "../../modules/agents/tools/registry.ts";
import type { ActionDefinition } from "../../modules/action-requests.ts";
import type {
  JobDef,
  PeriodicTask,
  SchedulerContribution,
} from "../jobs/types.ts";
import type {
  ChannelDirectory,
  ProjectHooks,
  ReadinessProvider,
  RetentionContribution,
} from "../governance/types.ts";
import type { ActionHandler } from "../http/actions.ts";
import type { RoutesContribution } from "../http/routes.ts";
import type {
  AssistantContribution,
  ConversationSections,
} from "../assistant/types.ts";
import type {
  TelegramCallback,
  TelegramContribution,
} from "../connections/types.ts";

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
  /** Handlers of POST /api/projects/:id/actions/:name, by name (WP2.1f). */
  actions?: Readonly<Record<string, ActionHandler>>;
  /** HTTP routes at their existing absolute paths (WP2.1f). */
  routes?: RoutesContribution;
  /** The project's go-live readiness; at most one module provides it (WP2.1f). */
  readiness?: ReadinessProvider;
  /** Channels the module manages, by id, for display (WP2.1f). */
  channelDirectory?: ChannelDirectory;
  /** Prompt fragments, tool features and proposal checks (WP2.2). */
  assistant?: AssistantContribution;
  /** Fields a conversation read adds for the module (WP2.2). */
  conversationSections?: ConversationSections;
  /** Button callbacks of the owner's Telegram bot and its switch (WP2.5a). */
  telegram?: TelegramContribution;
};

// A callback_data prefix: short, so signed data stays within 64 bytes.
const CALLBACK_PREFIX = /^[a-z]{1,16}$/;

type Registered = {
  registry: ValidatedRegistry;
  byModule: ReadonlyMap<string, ModuleContributions>;
  tools: readonly OrbitTool[];
  actionTypes: ReadonlyMap<string, ActionDefinition<any>>;
  jobs: ReadonlyMap<string, JobDef>;
  publicViews: ReadonlyMap<string, (row: any) => any>;
  periodic: readonly PeriodicTask[];
  actions: ReadonlyMap<string, ActionHandler>;
  telegramCallbacks: ReadonlyMap<
    string,
    { owner: string; handle: TelegramCallback }
  >;
  /** Owner ("platform" or a module id) of each named contribution (WP2.4). */
  owners: {
    tools: ReadonlyMap<string, string>;
    actions: ReadonlyMap<string, string>;
    jobs: ReadonlyMap<string, string>;
    periodic: ReadonlyMap<string, string>;
  };
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
  if (ordered.filter(([, c]) => c.readiness).length > 1)
    problems.push("more than one readiness provider");
  const tools: OrbitTool[] = [];
  const actionTypes = new Map<string, ActionDefinition<any>>();
  const jobs = new Map<string, JobDef>();
  const publicViews = new Map<string, (row: any) => any>();
  const periodic: PeriodicTask[] = [];
  const actions = new Map<string, ActionHandler>();
  const telegramCallbacks = new Map<
    string,
    { owner: string; handle: TelegramCallback }
  >();
  const owners = {
    tools: new Map<string, string>(),
    actions: new Map<string, string>(),
    jobs: new Map<string, string>(),
    periodic: new Map<string, string>(),
  };
  for (const [owner, c] of ordered) {
    for (const tool of c.tools ?? []) owners.tools.set(tool.name, owner);
    for (const name of Object.keys(c.actions ?? {}))
      owners.actions.set(name, owner);
    for (const job of c.jobs ?? []) owners.jobs.set(job.queueClass, owner);
    for (const task of c.periodic ?? []) owners.periodic.set(task.name, owner);
    for (const [prefix, handle] of Object.entries(
      c.telegram?.callbacks ?? {},
    )) {
      if (!CALLBACK_PREFIX.test(prefix))
        problems.push(`invalid Telegram callback prefix ${prefix}`);
      if (telegramCallbacks.has(prefix))
        problems.push(`Telegram callback ${prefix} registered twice`);
      telegramCallbacks.set(prefix, { owner, handle });
    }
    for (const [name, handler] of Object.entries(c.actions ?? {})) {
      if (actions.has(name)) problems.push(`action ${name} registered twice`);
      actions.set(name, handler);
    }
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
    actions,
    telegramCallbacks,
    owners,
  };
}

function current(): Registered {
  // Fail closed: without registration no tool, action type, job or
  // projection silently disappears.
  if (!registered) throw new Error("MODULE_CONTRIBUTIONS_NOT_REGISTERED");
  return registered;
}

/**
 * True when an owner's contributions count for a project: the platform's
 * always; a module's when no enabled set is given or it is in it (WP2.4).
 */
export function ownerEnabled(
  owner: string | undefined,
  enabled?: ReadonlySet<string>,
) {
  return !enabled || !owner || owner === "platform" || enabled.has(owner);
}
function fromOwners<T>(
  pick: (c: ModuleContributions) => T | undefined,
  enabled?: ReadonlySet<string>,
): T[] {
  return [...current().byModule.entries()]
    .filter(([owner]) => ownerEnabled(owner, enabled))
    .map(([, c]) => pick(c))
    .filter((v): v is T => Boolean(v));
}
/** The validated registry the contributions were registered for. */
export function registeredRegistry(): ValidatedRegistry {
  return current().registry;
}
export const registeredToolOwner = (name: string) =>
  current().owners.tools.get(name);
export const registeredActionOwner = (name: string) =>
  current().owners.actions.get(name);
export const registeredJobOwner = (queueClass: string) =>
  current().owners.jobs.get(queueClass);

/**
 * Assistant tools of every module, platform first, then in registry order;
 * only those of enabled modules when an enabled set is given (WP2.4).
 */
export function registeredTools(
  enabled?: ReadonlySet<string>,
): readonly OrbitTool[] {
  const { tools, owners } = current();
  return enabled
    ? tools.filter((t) => ownerEnabled(owners.tools.get(t.name), enabled))
    : tools;
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
export function registeredSchedulers(
  enabled?: ReadonlySet<string>,
): SchedulerContribution[] {
  const all = [...current().byModule.entries()].filter(([id]) =>
    ownerEnabled(id, enabled),
  );
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
export function registeredPeriodicTasks(
  enabled?: ReadonlySet<string>,
): readonly PeriodicTask[] {
  const { periodic, owners } = current();
  return enabled
    ? periodic.filter((t) => ownerEnabled(owners.periodic.get(t.name), enabled))
    : periodic;
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

/** The handler of a project action, or undefined for an unknown name. */
export function registeredAction(name: string): ActionHandler | undefined {
  return current().actions.get(name);
}
/** Every registered action name. */
export function registeredActionNames(): string[] {
  return [...current().actions.keys()];
}

/** Route registrations: platform first, then modules in registry order. */
export function registeredRoutes(): RoutesContribution[] {
  return fromOwners((c) => c.routes);
}
/** Route registrations with their owner, for the activation guard (WP2.4). */
export function registeredRoutesByOwner(): Array<[string, RoutesContribution]> {
  return [...current().byModule.entries()].flatMap(([owner, c]) =>
    c.routes ? [[owner, c.routes] as [string, RoutesContribution]] : [],
  );
}

/** The registered readiness provider, if any. */
export function registeredReadiness(): ReadinessProvider | undefined {
  return [...current().byModule.values()].find((c) => c.readiness)?.readiness;
}
/** Channel directories: platform first, then modules in registry order. */
export function registeredChannelDirectories(): ChannelDirectory[] {
  return [...current().byModule.values()]
    .map((c) => c.channelDirectory)
    .filter((d): d is ChannelDirectory => Boolean(d));
}

/** Assistant contributions: platform first, then modules in registry order. */
export function registeredAssistants(
  enabled?: ReadonlySet<string>,
): AssistantContribution[] {
  return fromOwners((c) => c.assistant, enabled);
}

/** Conversation sections: platform first, then modules in registry order. */
export function registeredConversationSections(
  enabled?: ReadonlySet<string>,
): ConversationSections[] {
  return fromOwners((c) => c.conversationSections, enabled);
}

/**
 * The handler of a Telegram button by its callback_data prefix, with its
 * owner for the activation check, or undefined for an unknown prefix.
 */
export function registeredTelegramCallback(prefix: string) {
  return current().telegramCallbacks.get(prefix);
}
/** Whether the owner's Telegram bot is on: one contributor says so. */
export function telegramContributorEnabled(): boolean {
  return [...current().byModule.values()].some(
    (c) => c.telegram?.enabled?.() === true,
  );
}
