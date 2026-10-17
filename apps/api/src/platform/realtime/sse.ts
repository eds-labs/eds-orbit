import type { FastifyReply, FastifyRequest } from "fastify";
import {
  realtimeChannel,
  realtimeHub,
  type RealtimeHub,
  type RealtimeSubscription,
} from "./fanout.ts";

/** One server-sent event; `id` is the stream's cursor and grows strictly. */
export type StreamEvent = { id: number; event: string; data: unknown };

/** What the database holds after a cursor, and whether the stream is over. */
export type StreamReplay = { events: StreamEvent[]; done: boolean };

export type EventStreamOptions = {
  projectId: string;
  /** "<kind>:<uuid>", the same name its writers publish on. */
  stream: string;
  /**
   * Reads the events after `after` (null: from the start) from the database,
   * the source of truth. Called on connect, on every wake-up and while Redis
   * is down; it must be cheap and read-only.
   */
  replay(after: number | null): Promise<StreamReplay>;
  hub?: RealtimeHub;
  /** The stream ends before the web proxy's 45 s cut; the client resumes. */
  maxDurationMs?: number;
  keepaliveMs?: number;
  /** Replay interval while Redis is down (slow polling). */
  fallbackPollMs?: number;
  /** Reconnect delay the client is told to use. */
  retryMs?: number;
};

export const STREAM_DEFAULTS = {
  maxDurationMs: 39000,
  keepaliveMs: 15000,
  fallbackPollMs: 5000,
  retryMs: 1000,
};

/** The cursor a reconnecting client sends; null when absent or malformed. */
export function lastEventId(req: FastifyRequest): number | null {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * Serves one SSE stream from the real-time fan-out (WP4.3 Part B). It
 * subscribes first and replays from the database afterwards, so a change
 * committed in between is in the replay; every later wake-up replays again
 * after the client's cursor. Nothing polls the database while Redis is up.
 * While Redis is down it replays every `fallbackPollMs` instead, and once
 * Redis is back it replays immediately. A reconnect sends `Last-Event-ID`
 * and resumes after it, so the proxy cut loses no event.
 *
 * Authorize the caller before calling this; the reply is hijacked here.
 */
export async function serveEventStream(
  req: FastifyRequest,
  reply: FastifyReply,
  options: EventStreamOptions,
) {
  const settings = { ...STREAM_DEFAULTS, ...definedOnly(options) };
  const hub = options.hub ?? realtimeHub();
  const channel = realtimeChannel(options.projectId, options.stream);
  const out = reply.raw;
  reply.hijack();
  out.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  out.write(`retry: ${settings.retryMs}\n\n`);

  let cursor = lastEventId(req);
  let closed = false;
  let running = false;
  let again = false;
  let poller: NodeJS.Timeout | undefined;
  let subscription: RealtimeSubscription | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;

  function finish() {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    clearInterval(keepalive);
    clearInterval(poller);
    subscription?.unsubscribe();
    if (!out.destroyed && !out.writableEnded) out.end();
  }
  function polling(on: boolean) {
    if (closed) return;
    if (on && !poller)
      poller = setInterval(() => void pump(), settings.fallbackPollMs);
    if (!on && poller) {
      clearInterval(poller);
      poller = undefined;
    }
  }
  // At most one replay runs per stream; wake-ups during it run one more.
  async function pump() {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const { events, done } = await options.replay(cursor);
        if (closed || out.destroyed) return finish();
        for (const event of events) {
          if (cursor !== null && event.id <= cursor) continue;
          out.write(
            `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
          cursor = event.id;
        }
        if (done) return finish();
      } while (again && !closed);
    } catch {
      finish();
    } finally {
      running = false;
    }
  }

  out.on("close", finish);
  deadline = setTimeout(finish, settings.maxDurationMs);
  keepalive = setInterval(() => {
    if (!closed && !out.destroyed) out.write(": keepalive\n\n");
  }, settings.keepaliveMs);
  try {
    subscription = await hub.subscribe(channel, {
      wake(at) {
        // A wake-up for what the client already has needs no read.
        if (at !== null && cursor !== null && at <= cursor) return;
        void pump();
      },
      degraded(down) {
        polling(down);
        if (!down) void pump();
      },
    });
  } catch {
    subscription = undefined;
  }
  if (closed) return subscription?.unsubscribe();
  polling(!subscription?.live);
  await pump();
}

function definedOnly(options: EventStreamOptions) {
  const picked: Partial<typeof STREAM_DEFAULTS> = {};
  for (const key of Object.keys(STREAM_DEFAULTS) as Array<
    keyof typeof STREAM_DEFAULTS
  >)
    if (options[key] !== undefined) picked[key] = options[key];
  return picked;
}
