# Real-time fan-out

Server-sent event (SSE) streams wait on Redis for changes instead of polling the database under the project lock (WP4.3 Part B, plan 06 S-R5). The Support live chat (WP5.4) needs this. Orbit Chat's run stream can use it now, behind a flag.

`ORBIT_REALTIME` is `false` by default. While it is off, nothing is published and the chat stream polls every 700 ms as before.

## How it works

- **Writers publish after commit.** Use `publishChange(projectId, stream, cursor?)` in `apps/api/src/platform/realtime/fanout.ts`.
  - Call it once the transaction has returned.
  - Inside a transaction, use `afterCommit(tx, fn)` from `packages/db`. It runs only after the commit, never after a rollback.
  - A publish is fire-and-forget. It never fails the write and never waits on a Redis outage.
- **One channel per project and stream.** The channel is `orbit:rt:<PUBLISHER_INSTANCE_ID>:<projectId>:<kind>:<uuid>`, for example `chat-run:<run id>`.
- **Messages are wake-ups only.** A message carries at most the new cursor (`{"cursor": 17}`), never content.
  - The database stays the only source of truth.
  - No chat or support text passes through Redis (plan 06 S-R11).
- **Streams subscribe, then replay.** `serveEventStream()` in `apps/api/src/platform/realtime/sse.ts`:
  1. subscribes to the channel;
  2. replays from the database after the client's `Last-Event-ID`;
  3. replays again on every wake-up.
  
  Because it subscribes first, a change committed between the two steps is in the replay. A wake-up whose cursor the client already has costs no read. At most one replay runs per stream at a time, and wake-ups during a replay cause one more.
- **One subscriber connection per process.** `RealtimeHub` shares it between all open streams. Each channel is subscribed once and dropped with its last listener.
- **Resume after the proxy cut.** A stream ends after 39 s, before the web proxy's 45 s abort (`apps/web/src/app/api/[...path]/route.ts`).
  - The stream tells the browser `retry: 1000`.
  - EventSource reconnects with `Last-Event-ID`, and the proxy now forwards that header.
  - The stream resumes after it, so no event is lost and none is sent twice.
- **Redis down.** Pub/sub delivers at most once, so the design never relies on a message arriving.
  - While the hub's connection is down, each stream replays every 5 s (slow polling).
  - When Redis is back, the hub subscribes every open channel again, and each stream replays once and stops polling.
  - If a single publish is lost while the subscriber stays connected, the change shows at the next wake-up or at the next 39 s reconnect at the latest.

## Orbit Chat

With the flag on, `GET /api/projects/:projectId/chat/runs/:id/events` uses `serveEventStream()`:

- The cursor is the run's `sequence`.
- An event is the whole run snapshot (`runSnapshot`), so only the latest one matters.
- The stream ends with the first terminal status.

The chat runner publishes after each committed run write: running, transmitted, every text snapshot (every 450 ms while streaming), succeeded and failed. Cancel and the pause stop publish too, the pause stop through `afterCommit`. Creating a run publishes nothing, because no one can be subscribed yet.

The route, authorization and the event format are unchanged. A stream asks the database only:

- once on connect;
- once per change;
- every 5 s while Redis is down.

The old route made about 1.4 locked transactions per second for each open stream (`docs/evidence/lock-measurement-2026-10-17.md`).

## Adding a stream (WP5.4 and later)

1. Name it `<kind>:<uuid>`, for example `support-conversation:<id>`.
2. Give it a strictly increasing cursor in the database, for example a per-conversation message sequence.
3. After every committed change, call `publishChange(projectId, stream, cursor)`, or `afterCommit` inside a transaction.
4. In the route, authorize first. Then call `serveEventStream(req, reply, { projectId, stream, replay })`.
   - `replay(after)` reads the events after `after` (or from the start when `after` is null) and says whether the stream is over.
   - It must be read-only and bounded, because it also runs while Redis is down.

Public (widget) streams also need the public ingress pattern (WP4.2): key, session, origin and rate limits. That is WP5.4's work, not this module's.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ORBIT_REALTIME` | `false` | `true`: writers publish, and the chat SSE route waits on Redis. The API and the worker need the same value (both get it from the same Compose variable). |
| `REDIS_URL` | required | The existing Redis; no new service. |

## Rollback

Set `ORBIT_REALTIME=false` and redeploy. The chat stream polls again, and writers stop publishing. Nothing is stored, so there is nothing to migrate or clean up.

## Verification

- `apps/api/tests/realtime.integration.test.ts`, against real Redis with an in-memory event log that counts every replay:
  - 20 concurrent subscribers with p95 delivery under 1 s, and no replay while idle;
  - four concurrent writers with order and completeness;
  - repeated cuts with `Last-Event-ID` resume, losing no event and duplicating none;
  - a malformed `Last-Event-ID`;
  - Redis unreachable from the start (slow polling);
  - Redis cut mid-stream through a TCP relay, with polling and then recovery without loss;
  - flag off.
- `apps/api/tests/chat-realtime.integration.test.ts`, against the database and Redis:
  - 10 streams on one run, with p95 under 1 s and no transaction at all during 2 idle seconds;
  - `Last-Event-ID` resume;
  - the pause stop publishing after commit;
  - another member's run answering 404;
  - flag off keeping the polling route;
  - `afterCommit` running after a commit and never after a rollback.
- Measured locally on 2026-10-17 over three runs: fan-out p95 4–7 ms over 500 deliveries, chat SSE p95 18–30 ms over about 310 deliveries.
- A mutation check confirmed the tests:
  - forcing polling on fails the idle check;
  - dropping the publish fails every delivery test.
- The production-host measurement stays as planned in the Part A report: the same script against a staging copy before Phase 5, never against production data.
