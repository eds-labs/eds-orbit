import { api, post, put, remove, patch, ApiError } from "@/lib/api";

// The personal Orbit Assistant's API as the web app uses it (ADR 0022,
// plan agent-platform-phase-3 §2.6/§2.7). Hand-written like `Dashboard`; the
// server types live in apps/api/src/platform/assistant/.

/** GET /api/assistant: whether this member may use the personal assistant. */
export type AssistantStatus =
  | {
      enabled: true;
      workspaceId: string;
      /** The personal space: the chat runs on its project chat routes. */
      personalSpaceId: string;
      capMicros: number | null;
      autoMemory: boolean;
    }
  | {
      enabled: false;
      workspaceId: string;
      reason: "ASSISTANT_DISABLED_FOR_MEMBER" | "ASSISTANT_ENTITLEMENT";
    };

export type ActionRequestRef = {
  id: string;
  version: number;
  packageHash: string;
  /** The member may decide it in the card's project. */
  decidable: boolean;
  /** Its type can be decided from the card (not governance, no full view). */
  inline: boolean;
};

export type ContextCategory =
  "preference" | "project_note" | "decision" | "workflow";

export type ChatCard = {
  kind:
    | "source"
    | "asset"
    | "link"
    | "status"
    | "assignment"
    | "marketing_plan"
    | "context_proposal"
    | (string & {});
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
  /** The business project the card belongs to (personal mode). */
  projectId?: string;
  projectName?: string;
  actionRequest?: ActionRequestRef;
  contextProposal?: {
    text: string;
    category: ContextCategory;
    projectId?: string;
  };
  // Module cards carry their content by value, e.g. assignments (R16).
  assignment?: Record<string, any>;
  marketingPlan?: Record<string, any>;
};

export type ChatNotice = {
  kind: "work_order_finished" | "work_order_failed" | "context_saved";
  entryId?: string;
  text?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  cards: ChatCard[];
  notice?: ChatNotice;
};

export type RunStep = {
  tool: string;
  projectId?: string;
  projectName?: string;
  state: "started" | "finished" | "failed";
};

export type ChatRun = {
  id: string;
  status: string;
  partialText: string;
  errorCode: string | null;
  sequence: number;
  steps?: RunStep[];
};

export type Conversation = { id: string; title: string; updatedAt: string };

export type Proposal = {
  id: string;
  groupId: string;
  version: number;
  payloadHash: string;
  status: string;
  missionId?: string;
  jobId?: string;
  action?: {
    status: string;
    error: string | null;
    contentId: string | null;
  } | null;
  payload: {
    mission: {
      title: string;
      goal: string;
      audience: string;
      channels: string[];
      startAt: string;
      endAt: string;
      maxContents: number;
      sourceIds: string[];
      assetIds: string[];
    };
    firstDraftMaxMicros: number;
    planMaxMicros: number;
    sources: { id: string }[];
    assets: { id: string }[];
  };
};

// Modules add fields such as packages and assignments (WP2.2).
export type ConversationDetail = {
  conversation: Conversation;
  messages: ChatMessage[];
  runs: ChatRun[];
  proposals: Proposal[];
} & Record<string, any>;

/** Optional hints of a personal turn; the server never grants access by them. */
export type PageContext = {
  projectId?: string;
  route?: string;
  entity?: { type: string; id: string };
};

export type SendExtras = {
  pageContext?: PageContext;
  focusProjectId?: string;
};

export type ContextEntry = {
  id: string;
  version: number;
  category: ContextCategory;
  text: string;
  projectId: string | null;
  status: "active" | "archived";
  createdBy: "user" | "assistant" | "assistant_confirmed";
  createdAt: string;
};

export type ContextList = { items: ContextEntry[]; autoMemory: boolean };

export const CONTEXT_MAX_CHARS = 500;
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  "preference",
  "project_note",
  "decision",
  "workflow",
];

/**
 * Adds the organization whose personal space a request concerns. The API
 * resolves the organization of every /api/assistant* route from it and falls
 * back to the user's oldest organization without it, so a member of several
 * organizations must always send it.
 */
export function withWorkspace(path: string, workspaceId?: string) {
  if (!workspaceId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export const assistantPaths = {
  status: (workspaceId?: string) => withWorkspace("/assistant", workspaceId),
  context: (workspaceId?: string) =>
    withWorkspace("/assistant/context", workspaceId),
  contextEntry: (id: string, workspaceId?: string) =>
    withWorkspace(`/assistant/context/${encodeURIComponent(id)}`, workspaceId),
  contextSettings: (workspaceId?: string) =>
    withWorkspace("/assistant/context/settings", workspaceId),
  /** A same-origin download (the browser sends the session cookie). */
  contextExport: (workspaceId?: string) =>
    withWorkspace("/api/assistant/context/export", workspaceId),
};

/** The send body of one chat message, with the optional personal hints. */
export function messageBody(
  text: string,
  clientRequestId: string,
  extras: SendExtras = {},
) {
  return {
    text,
    clientRequestId,
    ...(extras.pageContext ? { pageContext: extras.pageContext } : {}),
    ...(extras.focusProjectId ? { focusProjectId: extras.focusProjectId } : {}),
  };
}

export type ContextApi = ReturnType<typeof contextApiFor>;

/** The personal context requests in one organization's personal space. */
export function contextApiFor(workspaceId: string | undefined) {
  return {
    list: () => api<ContextList>(assistantPaths.context(workspaceId)),
    create: (input: {
      category: ContextCategory;
      text: string;
      projectId?: string;
    }) =>
      post<ContextEntry>(assistantPaths.context(workspaceId), {
        category: input.category,
        text: input.text,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    update: (
      entry: Pick<ContextEntry, "id" | "version">,
      change: Partial<
        Pick<ContextEntry, "text" | "category" | "projectId" | "status">
      >,
    ) =>
      patch<ContextEntry>(assistantPaths.contextEntry(entry.id, workspaceId), {
        version: entry.version,
        ...change,
      }),
    remove: (id: string) =>
      remove(assistantPaths.contextEntry(id, workspaceId)),
    settings: (autoMemory: boolean) =>
      put<{ autoMemory: boolean }>(
        assistantPaths.contextSettings(workspaceId),
        {
          autoMemory,
        },
      ),
  };
}

/** Whether an error means the feature is off (404): hide every entry. */
export function featureOff(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}
