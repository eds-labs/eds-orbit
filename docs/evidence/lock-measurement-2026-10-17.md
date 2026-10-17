# Project lock measurement (WP4.3 Part A, 2026-10-17)

**Question.** Every `scoped()` transaction takes a per-project advisory lock (`packages/db/src/index.ts`). Does that lock limit concurrent use of one project? Does any transaction hold it across a slow provider call?

**Answer.**
- At the measured loads, no. Waits stay in the low milliseconds.
- No transaction holds the lock across a model call or an embedding.
- The cost that grows is polling: every open chat stream adds about 1.4 transactions per second to the same lock.

## Method

- **Hook.** `lockObserver.observe` in `packages/db` records, for every `scoped()` transaction, the time from asking for the lock to holding it (wait) and from holding it to the end of the work (hold). It is unset in production.
- **Load.** `scripts/measure/lock-load.measure.ts` runs real application code against the local test database (PostgreSQL 17, Docker, developer machine), on one synthetic project. Every generator is tagged with `AsyncLocalStorage`. The generators:
  - **chat_run:** back-to-back assistant runs. The scripted model takes **1.5 s** per call.
  - **search:** `retrieveHybrid` every 3 s. The embedding takes **1 s**.
  - **writer:** two writers, each creating an entity every 300 ms.
  - **sweep:** the scheduler sweep every 2 s.
  - **stream_poll:** `getRun` every 700 ms, as the chat SSE route does. Only in the second phase.
- **Phases.** 15 s without pollers, then 15 s with pollers. Two runs: 5 and 25 pollers.
- **Call time.** The end-to-end time of each generator call, including waiting for the connection pool (10 connections per client), is recorded too.

Run it with:

```bash
LOCK_POLLERS=25 LOCK_REPORT_FILE=lock.json node --env-file=.runtime/local.env ./node_modules/vitest/vitest.mjs run --config vitest.measure.config.ts
```

Raw results: [lock-measurement-2026-10-17.json](lock-measurement-2026-10-17.json).

## Results (milliseconds)

**5 pollers**

| Phase | Load | Transactions | Wait p50 | Wait p95 | Wait max | Hold p95 | Hold max | Call p95 |
|---|---|---|---|---|---|---|---|---|
| without pollers | all | 249 | 1.1 | 11.9 | 31.4 | 17.9 | 44.2 | — |
| without pollers | writer | 100 | 3.8 | 12.4 | 27.2 | 7.7 | 10.3 | 32 |
| with pollers | stream_poll | 110 | 6.4 | 18.2 | 25.5 | 4.2 | 7.2 | 33 |
| with pollers | writer | 100 | 3.7 | 13.3 | 19.8 | 7.4 | 10.0 | 31 |
| with pollers | all | 364 | 1.9 | 13.4 | 25.5 | 12.5 | 33.7 | — |

**25 pollers**

| Phase | Load | Transactions | Wait p50 | Wait p95 | Wait max | Hold p95 | Hold max | Call p95 |
|---|---|---|---|---|---|---|---|---|
| without pollers | all | 249 | 1.2 | 18.4 | 110.1 | 21.7 | 66.0 | — |
| with pollers | stream_poll | 550 | 15.1 | 26.5 | 36.8 | 2.7 | 18.5 | 71 |
| with pollers | writer | 100 | 4.4 | 13.9 | 16.3 | 8.4 | 9.5 | 28 |
| with pollers | all | 804 | 12.4 | 25.1 | 36.8 | 8.4 | 41.5 | — |

A chat run takes about 1.6 s end to end and a search about 1.2 s. Their longest single hold was 66 ms.

## Findings

1. **No lock across a provider call.** The chat runner and the hybrid retrieval do their model and embedding calls outside `scoped()`. The longest holds belong to search telemetry and chat bookkeeping, all below 70 ms, while the calls themselves take 1–1.5 s.
2. **The lock does not limit one project at this load.** With 25 open chat streams (804 transactions in 15 s, about 54 per second), writers keep a call p95 of 28 ms and polls of 71 ms. The single 110 ms wait without pollers is an outlier of a writer behind a search's telemetry write.
3. **Polling is the cost that scales.** Each open chat stream is one locked transaction every 700 ms, and the poll's own lock wait grows with the number of streams: p50 6 ms at 5, 15 ms at 25. A support live chat with many visitors would multiply this, which is why `06` §5 (S-R5) asks for real-time delivery without DB polling.
4. **Not measured.** A production host, several projects at once, the worker's specialist runs, and network latency between API and database. The local database is on the same machine.

## Recommendation for Part B

- **No `scopedRead()` now.** The lock is not a bottleneck for the assistant, so removing it from read paths would add risk (invariants may rely on it) without a measured benefit.
- **Redis pub/sub when Support starts** (Phase 5, or WP4.3 Part B just before it):
  - writers publish after commit;
  - SSE subscribes and replays from the database with `Last-Event-ID`;
  - if Redis is down, it falls back to slow polling.
  
  This removes the polling cost that scales with open streams. The chat SSE can move onto it in the same step.
- **Repeat the measurement on the production host** before Phase 5, with the same script against a staging copy, never against production data.

## Part B (2026-10-17)

Implemented as recommended, behind `ORBIT_REALTIME` (default off). See `docs/REALTIME_FANOUT.md`:

- writers publish after commit;
- SSE subscribes and replays from the database with `Last-Event-ID`;
- slow polling while Redis is down;
- the chat SSE route moves onto it.

No `scopedRead()` (Mario, 2026-10-17). With the flag on, an open chat stream makes no transaction while its run is idle (tested), instead of one every 700 ms. This report's load script was not repeated, because its `stream_poll` generator models the old route. The production-host measurement remains as planned above.
