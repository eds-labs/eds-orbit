/** Standard MCP resources and 2026-07-28 subscriptions over durable task state. */
import { z } from "zod";
import type { Server } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "./principal.ts";
import { projectScope } from "./principal.ts";
import { principalModules } from "./visibility.ts";
import { lacksModuleConsent } from "./scopes.ts";
import { readTask, listTasks } from "../tasks/tasks.ts";
import { DomainError } from "../shared.ts";
import { mcp2Enabled } from "../tasks/operation-tools.ts";
import {
  realtimeChannel,
  realtimeEnabled,
  realtimeHub,
  type RealtimeSubscription,
} from "../realtime/fanout.ts";

export const taskUri = (projectId: string, taskId: string) =>
  `orbit://tasks/${projectId}/${taskId}`;
export function parseTaskUri(uri: string) {
  const match = /^orbit:\/\/tasks\/([^/]+)\/([^/]+)$/.exec(uri);
  if (
    !match ||
    !z.uuid().safeParse(match[1]).success ||
    !z.uuid().safeParse(match[2]).success
  )
    throw new DomainError("NOT_FOUND", 404);
  return { projectId: match[1]!, taskId: match[2]! };
}
export async function readTaskResource(p: McpPrincipal, uri: string) {
  if (!mcp2Enabled() || !p.scopes.has("orbit:read"))
    throw new DomainError("NOT_FOUND", 404);
  const { projectId, taskId } = parseTaskUri(uri);
  const scope = await projectScope(p, projectId);
  const task = await readTask(scope, taskId, p.clientId);
  const allowed = await principalModules(p, scope);
  if (
    (task.modules as string[]).some((m) => !allowed.includes(m)) ||
    ((task.modules as string[]).includes("support") &&
      !p.scopes.has("orbit:support")) ||
    lacksModuleConsent(task.modules as string[], p.scopes)
  )
    throw new DomainError("NOT_FOUND", 404);
  return task;
}
export function registerTaskResources(server: Server, p: McpPrincipal) {
  server.setRequestHandler("resources/read", async (request) => {
    try {
      const uri = request.params.uri;
      const task = await readTaskResource(p, uri);
      return {
        contents: [
          { uri, mimeType: "application/json", text: JSON.stringify(task) },
        ],
      };
    } catch {
      throw new Error("NOT_FOUND");
    }
  });
  server.setRequestHandler("resources/list", async () => ({ resources: [] }));
}

const listenInput = z
  .object({
    id: z.union([z.string().max(100), z.number()]),
    params: z
      .object({
        notifications: z
          .object({
            resourceSubscriptions: z.array(z.string().max(150)).min(1).max(5),
          })
          .strict(),
        _meta: z.unknown().optional(),
      })
      .strict(),
  })
  .passthrough();

/** Bounded process-local connections; state and replay are always in PostgreSQL. */
export class TaskSubscriptions {
  private active = new Map<string, Set<() => void>>();
  constructor(private options: { pollMs?: number; lifetimeMs?: number } = {}) {}
  close() {
    for (const group of this.active.values())
      for (const stop of [...group]) stop();
  }
  async listen(
    raw: unknown,
    initial: McpPrincipal,
    refresh: () => Promise<McpPrincipal | null>,
  ) {
    const input = listenInput.parse(raw);
    const uris = [...new Set(input.params.notifications.resourceSubscriptions)];
    const key = `${initial.userId}|${initial.clientId}|${initial.workspaceId}`;
    const group = this.active.get(key) ?? new Set<() => void>();
    if (group.size >= 2) throw new DomainError("MCP_SUBSCRIPTION_LIMIT", 429);
    // Initial authorization before returning a streaming response.
    const pending = () => {};
    group.add(pending);
    this.active.set(key, group);
    let initialStates: Awaited<ReturnType<typeof readTaskResource>>[];
    try {
      initialStates = await Promise.all(
        uris.map((uri) => readTaskResource(initial, uri)),
      );
    } catch (error) {
      group.delete(pending);
      if (!group.size) this.active.delete(key);
      throw error;
    }
    const signatures = new Map(
      uris.map((uri, i) => [uri, JSON.stringify(initialStates[i])]),
    );
    const subscriptions: RealtimeSubscription[] = [];
    const encoder = new TextEncoder();
    let closed = false,
      busy = false;
    let tick: NodeJS.Timeout | undefined, end: NodeJS.Timeout | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      clearTimeout(end);
      for (const sub of subscriptions) sub.unsubscribe();
      group.delete(stop);
      if (!group.size) this.active.delete(key);
      try {
        controller.close();
      } catch {
        /* peer already disconnected */
      }
    };
    const send = (message: Record<string, unknown>) => {
      if (!closed)
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify(message)}\n\n`,
          ),
        );
    };
    const meta = { "io.modelcontextprotocol/subscriptionId": input.id };
    const poll = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const principal = await refresh();
        if (!principal || !mcp2Enabled()) return stop();
        for (const uri of uris) {
          const task = await readTaskResource(principal, uri);
          const signature = JSON.stringify(task);
          if (signature !== signatures.get(uri)) {
            signatures.set(uri, signature);
            send({
              jsonrpc: "2.0",
              method: "notifications/resources/updated",
              params: { uri, _meta: meta },
            });
          }
        }
      } catch {
        stop();
      } finally {
        busy = false;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        send({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: { resourceSubscriptions: uris },
            _meta: meta,
          },
        });
      },
      cancel() {
        stop();
      },
    });
    group.delete(pending);
    group.add(stop);
    this.active.set(key, group);
    tick = setInterval(() => void poll(), this.options.pollMs ?? 5000);
    end = setTimeout(() => {
      send({ jsonrpc: "2.0", id: input.id, result: { _meta: meta } });
      stop();
    }, this.options.lifetimeMs ?? 60000);
    // Existing Redis wakeups reduce latency; bounded periodic replay also
    // catches approval changes, outages and grant expiration without Redis.
    if (realtimeEnabled())
      for (const task of initialStates)
        if (task.runId) {
          const sub = await realtimeHub().subscribe(
            realtimeChannel(task.projectId, `chat-run:${task.runId}`),
            { wake: () => void poll(), degraded: () => void poll() },
          );
          if (closed) sub.unsubscribe();
          else subscriptions.push(sub);
        }
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
}
