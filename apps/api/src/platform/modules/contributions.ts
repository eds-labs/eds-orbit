import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { FetchLike } from "../../../../../packages/connectors/src/index.ts";
import type { UserNotificationKind } from "../notifications/members.ts";
import type { ValidatedRegistry } from "../../../../../packages/module-contracts/src/index.ts";
import type { ImpactHandler } from "../../../../../packages/knowledge/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
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
import type {
  ConnectionProvider,
  ConnectionsContribution,
} from "../connections/connections.ts";
import type {
  NotificationContribution,
  NotificationRender,
} from "../notifications/types.ts";

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
  /** Notification kinds for the owner's bot and their rendering (WP2.5b). */
  notifications?: NotificationContribution;
  /** Connection providers: form fields, normalization, check (WP2.5c). */
  connections?: ConnectionsContribution;
  /**
   * Invalidates the module's records that depend on changed knowledge, in the
   * engine's transaction (WP3.1). Runs regardless of module activation.
   */
  knowledgeImpact?: ImpactHandler;
  /**
   * The permission each of the module's actions needs, by action name
   * (WP4.1); an action without one needs the writer level.
   */
  actionPermissions?: Readonly<Record<string, PermissionDef>>;
  /**
   * Signed provider webhooks the module receives through the platform's
   * POST /api/hooks/:provider/... route (WP4.2), by provider name.
   */
  webhooks?: Readonly<Record<string, WebhookProvider>>;
  /**
   * The module's public API for browsers on a key's allowed origins (WP4.2b),
   * mounted at /api/public/<module>/:publicKey<path>; every call carries a
   * public session's bearer token.
   */
  publicRoutes?: readonly PublicRoute[];
  /**
   * Inbound e-mail of the project's mailbox (WP4.7): the platform stores
   * each message as `inbound_emails` and enqueues this queue class with the
   * row's id. Bounces are the platform's and never handed over.
   */
  emailInbound?: { queueClass: string };
  /**
   * Member notification kinds the module sends with `notifyMembers`
   * (WP4.7), by kind name, unique across modules.
   */
  userNotifications?: Readonly<Record<string, UserNotificationKind>>;
  /**
   * False while the module is switched off for the whole installation, such
   * as support without ORBIT_SUPPORT (WP5.1): projects neither see it in the
   * module list nor can enable it. Absent: always available.
   */
  available?: () => boolean;
};

/** What a public route's handler receives (WP4.2b). */
export type PublicRouteContext = {
  /** The project, as the public client sees it: role viewer, no member. */
  scope: Scope;
  session: { id: string; keyId: string };
  body: unknown;
  query: Readonly<Record<string, string>>;
};

/** One route of a module's public API (WP4.2b). */
export type PublicRoute = {
  method: "GET" | "POST";
  /** Below the key, such as "/requests"; lowercase segments only. */
  path: string;
  /**
   * A GET route may stream instead (WP5.4): `stream` authorizes and returns
   * the event stream's project, name and replay; the platform serves it
   * with the key's CORS answer and Last-Event-ID resume.
   */
  handler(ctx: PublicRouteContext): Promise<unknown>;
  stream?(ctx: PublicRouteContext): Promise<{
    projectId: string;
    stream: string;
    replay(after: number | null): Promise<{
      events: Array<{ id: number; event: string; data: unknown }>;
      done: boolean;
    }>;
  }>;
};

/**
 * A provider whose webhooks reach the platform's route (WP4.2): either
 * stored and queued (`SignedWebhookProvider`) or answered within the request
 * (`DirectWebhookProvider`).
 */
export type WebhookProvider = SignedWebhookProvider | DirectWebhookProvider;

/** A provider whose signed webhooks a module processes in its worker job. */
export type SignedWebhookProvider = {
  direct?: undefined;
  /** The connection provider whose connection holds the signing secret. */
  connectionProvider: string;
  /** True when the signature over the raw body is valid for the credential. */
  verify(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
    credential: string;
    now: Date;
  }): boolean;
  /**
   * The provider's id of the message, for idempotency; null rejects it. It
   * must be covered by the signature `verify` checks (a field of the signed
   * body, or a header the signature includes); otherwise a captured delivery
   * replays under a new id. A provider that signs a timestamp should also
   * reject old ones in `verify`.
   */
  messageId(input: {
    body: unknown;
    headers: Readonly<Record<string, string | undefined>>;
  }): string | null;
  /** The worker queue class that processes the stored message. */
  queueClass: string;
};

/**
 * A provider that must answer within the request, such as Slack's
 * interactions and the owner's Telegram bot (WP4.2 follow-up). The platform
 * owns the path, flag, size, media type and rate limit; the provider checks
 * its own secret against its own connection and answers. It never sees a
 * session or cookie.
 */
export type DirectWebhookProvider = {
  direct: true;
  /** Accepted bodies: JSON and/or form-encoded. */
  bodies: readonly ("json" | "form")[];
  handle(input: {
    workspaceId: string;
    projectId: string;
    connectionId: string;
    /** The body exactly as received. */
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
    /** For the provider calls of the answer; tests replace it. */
    fetch?: FetchLike;
  }): Promise<{
    status: 200 | 400 | 401 | 403 | 404 | 409;
    /** The error code of a refusal; a default per status otherwise. */
    code?: string;
    body?: unknown;
  }>;
};

// A callback_data prefix: short, so signed data stays within 64 bytes.
const CALLBACK_PREFIX = /^[a-z]{1,16}$/;
// A notification kind, as the job key `notify:<kind>:<ref>` carries it.
const NOTIFY_KIND = /^[a-z_]{1,40}$/;

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
  notifications: ReadonlyMap<
    string,
    { owner: string; render: NotificationRender }
  >;
  connectionProviders: ReadonlyMap<
    string,
    ConnectionProvider & { owner: string }
  >;
  actionPermissions: ReadonlyMap<string, PermissionDef>;
  webhooks: ReadonlyMap<string, WebhookProvider & { owner: string }>;
  emailInbound: readonly { owner: string; queueClass: string }[];
  userNotifications: ReadonlyMap<
    string,
    UserNotificationKind & { owner: string; kind: string }
  >;
  publicRoutes: ReadonlyMap<string, readonly PublicRoute[]>;
  /** Owner ("platform" or a module id) of each named contribution (WP2.4). */
  owners: {
    tools: ReadonlyMap<string, string>;
    actions: ReadonlyMap<string, string>;
    jobs: ReadonlyMap<string, string>;
    periodic: ReadonlyMap<string, string>;
    actionTypes: ReadonlyMap<string, string>;
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
  const notifications = new Map<
    string,
    { owner: string; render: NotificationRender }
  >();
  const connectionProviders = new Map<
    string,
    ConnectionProvider & { owner: string }
  >();
  const owners = {
    tools: new Map<string, string>(),
    actions: new Map<string, string>(),
    jobs: new Map<string, string>(),
    periodic: new Map<string, string>(),
    actionTypes: new Map<string, string>(),
  };
  for (const [owner, c] of ordered) {
    for (const tool of c.tools ?? [])
      owners.tools.set(tool.name, tool.alwaysOffered ? "platform" : owner);
    for (const name of Object.keys(c.actions ?? {}))
      owners.actions.set(name, owner);
    for (const job of c.jobs ?? []) owners.jobs.set(job.queueClass, owner);
    for (const task of c.periodic ?? []) owners.periodic.set(task.name, owner);
    for (const type of Object.keys(c.actionTypes ?? {}))
      owners.actionTypes.set(type, owner);
    for (const [prefix, handle] of Object.entries(
      c.telegram?.callbacks ?? {},
    )) {
      if (!CALLBACK_PREFIX.test(prefix))
        problems.push(`invalid Telegram callback prefix ${prefix}`);
      if (telegramCallbacks.has(prefix))
        problems.push(`Telegram callback ${prefix} registered twice`);
      telegramCallbacks.set(prefix, { owner, handle });
    }
    for (const kind of c.notifications?.kinds ?? []) {
      if (!NOTIFY_KIND.test(kind))
        problems.push(`invalid notification kind ${kind}`);
      if (notifications.has(kind))
        problems.push(`notification kind ${kind} registered twice`);
      notifications.set(kind, { owner, render: c.notifications!.render });
    }
    for (const [id, provider] of Object.entries(
      c.connections?.providers ?? {},
    )) {
      if (connectionProviders.has(id))
        problems.push(`connection provider ${id} registered twice`);
      connectionProviders.set(id, { ...provider, owner });
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
  // A module sets the permissions of its own actions only.
  const actionPermissions = new Map<string, PermissionDef>();
  for (const [owner, c] of ordered)
    for (const [name, permission] of Object.entries(
      c.actionPermissions ?? {},
    )) {
      if (owners.actions.get(name) !== owner)
        problems.push(
          `${owner} sets the permission of action ${name} it does not own`,
        );
      actionPermissions.set(name, permission);
    }
  // Public routes: modules only, distinct method and path per module.
  const publicRoutes = new Map<string, readonly PublicRoute[]>();
  for (const [owner, c] of ordered) {
    if (!c.publicRoutes?.length) continue;
    if (owner === "platform")
      problems.push("the platform has no public routes");
    const seen = new Set<string>();
    for (const route of c.publicRoutes) {
      if (!/^(\/[a-z][a-z0-9-]{0,30}){1,4}$/.test(route.path))
        problems.push(`${owner} public route ${route.path} is invalid`);
      if (route.path === "/session")
        problems.push(`${owner} public route /session is the platform's`);
      const id = `${route.method} ${route.path}`;
      if (seen.has(id))
        problems.push(`${owner} public route ${id} registered twice`);
      seen.add(id);
    }
    publicRoutes.set(owner, c.publicRoutes);
  }
  // Webhook providers: unique names, a queue class that exists.
  const webhooks = new Map<string, WebhookProvider & { owner: string }>();
  for (const [owner, c] of ordered)
    for (const [name, provider] of Object.entries(c.webhooks ?? {})) {
      if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name))
        problems.push(`invalid webhook provider ${name}`);
      if (webhooks.has(name))
        problems.push(`webhook provider ${name} registered twice`);
      if (provider.direct) {
        if (
          !provider.bodies.length ||
          provider.bodies.some((b) => b !== "json" && b !== "form")
        )
          problems.push(`webhook provider ${name} accepts no known body`);
      } else if (!jobs.has(provider.queueClass))
        problems.push(
          `webhook provider ${name} uses unknown queue class ${provider.queueClass}`,
        );
      webhooks.set(name, { ...provider, owner });
    }
  // Inbound e-mail consumers: a queue class that exists.
  const emailInbound: { owner: string; queueClass: string }[] = [];
  for (const [owner, c] of ordered)
    if (c.emailInbound) {
      if (!jobs.has(c.emailInbound.queueClass))
        problems.push(
          `${owner} takes inbound e-mail with unknown queue class ${c.emailInbound.queueClass}`,
        );
      emailInbound.push({ owner, queueClass: c.emailInbound.queueClass });
    }
  // Member notification kinds: valid, unique names.
  const userNotifications = new Map<
    string,
    UserNotificationKind & { owner: string; kind: string }
  >();
  for (const [owner, c] of ordered)
    for (const [kind, def] of Object.entries(c.userNotifications ?? {})) {
      if (!/^[a-z][a-z0-9_]{1,60}$/.test(kind))
        problems.push(`invalid notification kind ${kind}`);
      if (userNotifications.has(kind))
        problems.push(`notification kind ${kind} registered twice`);
      userNotifications.set(kind, { ...def, owner, kind });
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
    notifications,
    connectionProviders,
    actionPermissions,
    webhooks,
    emailInbound,
    userNotifications,
    publicRoutes,
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
 * always; an unavailable module's never (WP5.1); another module's when no
 * enabled set is given or it is in it (WP2.4).
 */
export function ownerEnabled(
  owner: string | undefined,
  enabled?: ReadonlySet<string>,
) {
  if (!owner || owner === "platform") return true;
  if (!moduleAvailable(owner)) return false;
  return !enabled || enabled.has(owner);
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
/**
 * True unless the module's contributions report it unavailable for this
 * installation (WP5.1). Before registration every module counts available.
 */
export function moduleAvailable(id: string) {
  return registered?.byModule.get(id)?.available?.() ?? true;
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
/** The module (or "platform") whose action request type this is (WP4.5). */
export const registeredActionTypeOwner = (type: string) =>
  current().owners.actionTypes.get(type);

/**
 * Assistant tools of every module, platform first, then in registry order;
 * only those of enabled modules when an enabled set is given (WP2.4).
 */
export function registeredTools(
  enabled?: ReadonlySet<string>,
): readonly OrbitTool[] {
  const { tools, owners } = current();
  // Always filtered: without an enabled set, unavailable modules (support
  // without ORBIT_SUPPORT) still offer nothing (WP5.6).
  return tools.filter((t) => ownerEnabled(owners.tools.get(t.name), enabled));
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

/**
 * Knowledge impact handlers: platform first, then modules in registry order.
 * Never filtered by activation: they protect data integrity, not features
 * (plans/orbit-modularization/05 §4).
 */
export function registeredImpactHandlers(): readonly ImpactHandler[] {
  return [...current().byModule.values()]
    .map((c) => c.knowledgeImpact)
    .filter((h): h is ImpactHandler => Boolean(h));
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
  return periodic.filter((t) =>
    ownerEnabled(owners.periodic.get(t.name), enabled),
  );
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

/** The public routes of every module that has some, by module. */
export function registeredPublicRoutes(): ReadonlyMap<
  string,
  readonly PublicRoute[]
> {
  return current().publicRoutes;
}

/** A member notification kind with its owner, or undefined (WP4.7). */
export function registeredUserNotification(kind: string) {
  return current().userNotifications.get(kind);
}
/** Every member notification kind, in registry order. */
export function registeredUserNotifications() {
  return [...current().userNotifications.values()];
}

/** The modules that take inbound e-mail, in registry order (WP4.7). */
export function registeredEmailInbound() {
  return current().emailInbound;
}

/** A webhook provider with its owner, or undefined for an unknown name. */
export function registeredWebhook(name: string) {
  return current().webhooks.get(name);
}

/** The permission a module declared for its action, or undefined. */
export function registeredActionPermission(
  name: string,
): PermissionDef | undefined {
  return current().actionPermissions.get(name);
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

/**
 * A notification kind with its owner and renderer, or undefined for a kind
 * no one registered (WP2.5b).
 */
export function registeredNotification(kind: string) {
  return current().notifications.get(kind);
}

/** A connection provider with its owner, or undefined (WP2.5c). */
export function registeredConnectionProvider(id: string) {
  return current().connectionProviders.get(id);
}
/** Every connection provider id: platform first, then registry order. */
export function registeredConnectionProviderIds(): string[] {
  return [...current().connectionProviders.keys()];
}
