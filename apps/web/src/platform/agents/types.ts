// The agent platform's API shapes as the web reads them (ADR 0021, WP1.5).
// The server code is the contract: apps/api/src/platform/agents/
// definitions/{schema,service,catalog}.ts and work-orders/service.ts. The
// web app never imports server code, so the shapes are restated here.

export type Bilingual = { en: string; de: string };

export type AgentMode = "read" | "draft" | "execute";
export type AgentStatus =
  "draft" | "active" | "paused" | "disabled" | "budget_exhausted";

export type ScheduleTrigger = {
  kind: "schedule";
  rhythm: "daily" | "weekly" | "interval";
  times: string[];
  days?: number[];
  everyMinutes?: number;
};
export type Trigger =
  | { kind: "manual" }
  | ScheduleTrigger
  | {
      kind: "event";
      type: string;
      filter: Record<string, unknown>;
      debounceSeconds: number;
    };

export type AgentConfig = {
  name: string;
  description: string;
  templateKey: string | null;
  instructions: string;
  modules: string[];
  tools: string[];
  knowledge: {
    sourceIds?: string[];
    audiences?: Array<"all" | "marketing" | "support">;
  } | null;
  mode: AgentMode;
  model: { override: string | null };
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    wallSeconds: number;
    maxRunsPerDay: number;
    maxConcurrent: number;
  };
  budget: { monthlyCeilingMicros: number; runCeilingMicros: number };
  triggers: Trigger[];
  delegateTo: string[];
  outputs: {
    notify: Array<"sponsor" | "agent_managers">;
    onFailure: "notify" | "silent";
  };
};

export type AgentView = {
  id: string;
  /** The entity version; every write sends it back. */
  version: number;
  name: string;
  status: AgentStatus;
  active: AgentConfig | null;
  draft: AgentConfig | null;
  activation: {
    sponsorUserId: string;
    activatedAt: string;
    version: number;
    configHash: string;
  } | null;
  /** sha256 of the draft; the activation binds to it. */
  draftHash: string | null;
};

export type CatalogRefusal =
  | "MODULE_DISABLED"
  | "MODULE_NOT_AVAILABLE"
  | "ROLE_INSUFFICIENT"
  | "FEATURE_OFF";

/** "unknown" only in step logs, for a tool no longer registered. */
export type ToolRisk = "R0_read" | "W0_internal" | "P_proposal";

export type CatalogTool = {
  name: string;
  module: string;
  risk: ToolRisk;
  title: Bilingual;
  summary: Bilingual;
  dataClass: "internal" | "customer_personal" | "financial";
  cost: "none" | "paid";
  needsApproval: boolean;
  mandatable: boolean;
  grantable: boolean;
  reason?: CatalogRefusal;
};
export type CatalogModule = { id: string; enabled: boolean; access: boolean };
export type CatalogEvent = {
  type: string;
  module: string;
  title: Bilingual;
  subject: string;
  sensitive: boolean;
};
export type Catalog = {
  tools: CatalogTool[];
  modules: CatalogModule[];
  events: CatalogEvent[];
};

export type AgentTemplate = {
  key: string;
  module: string;
  title: Bilingual;
  summary: Bilingual;
  defaults: Partial<AgentConfig>;
  guard: {
    requiredTools?: string[];
    forbiddenTools?: string[];
    maxMode?: AgentMode;
    lockedInstructions?: string;
  };
};

export type AgentVersionRow = {
  version: number;
  status: AgentStatus;
  activationVersion: number | null;
  createdAt: string;
};

export type WorkOrderStatus =
  | "queued"
  | "awaiting_start"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled"
  | "outcome_unknown";

export type WorkOrderStep = {
  index: number;
  tool: string;
  risk: string;
  outcome: "succeeded" | "failed";
  code?: string;
};

export type WorkOrderView = {
  id: string;
  agentId: string | null;
  agentVersion: number | null;
  origin: string;
  originRef: string | null;
  subject: { type: string; id: string | null } | null;
  onBehalfOf: { sponsorUserId: string | null; requesterUserId: string | null };
  allow: unknown;
  parentId: string | null;
  rootId: string;
  depth: number;
  goal: string;
  status: WorkOrderStatus;
  errorCode: string | null;
  ceilingMicros: number;
  spentMicros: number;
  costUnknown: boolean;
  result: {
    outcome?: string;
    summary?: string;
    actionRequestIds?: string[];
  } | null;
  steps: WorkOrderStep[] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkOrderPage = {
  items: WorkOrderView[];
  nextCursor: string | null;
};

export type AgentsSummary = {
  items: Array<{
    projectId: string;
    projectName: string;
    workspaceId: string;
    active: number;
    paused: number;
    failing24h: number;
  }>;
};
