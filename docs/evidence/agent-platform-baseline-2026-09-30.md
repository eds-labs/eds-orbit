# Agent platform baseline (2026-09-30)

Phase 0 baseline for the [OpenAI agent platform alignment plan](../OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md). It records what Orbit can measure today, before any runtime, routing or caching change. Every figure comes from settled production budget receipts already documented in `docs/ORBIT_ULIQUID_PRODUCTION_GOAL.md`. No new paid call, production query or provider request was made for this baseline.

## Cost per operation (settled receipts, USD micros)

| Operation | Model | Settled cost | Source (goal log entry) |
| --- | --- | --- | --- |
| Single Telegram draft (recovery job) | `gpt-5.6-terra` | 5,158 generation + 1 query embedding | 2026-09-28 15:12 |
| Single Telegram draft (unedited verification) | `gpt-5.6-terra` | 5,988 | 2026-09-28 20:15 |
| Single Telegram draft (final acceptance, `5587da6`) | `gpt-5.6-terra` | 7,650 | 2026-09-30 11:10 |
| Batch draft, per run (5 runs with previous-draft context) | `gpt-5.6-terra` | about 13,700–17,900 | 2026-09-28 21:55 |
| Chat run ending in one proposal attempt (5 `chat_text` + 1 `query_embedding` reservations) | `gpt-5.6-terra` | 35,024 | 2026-09-27 08:20 |

Planning ceilings shown to the owner: $0.12 per first draft (including retrieval) and $0.61 for a five-draft plan.

Observations:

- A chat run costs about five times a single draft, because each of up to six model calls re-sends the full input (`store: false`, no cache controls).
- Batch drafts cost about twice a single draft, because they carry previous drafts as context.
- Typical single-draft spend is well below the $0.12 ceiling (4–6 %), so the pre-estimate is very conservative.

## Not measurable today (gaps closed by plan Phase 1)

| Metric | Why it is missing |
| --- | --- |
| Latency per model call, tool call and run | No per-call trace records; only job and run status timestamps |
| Cached and cache-write tokens, reasoning tokens | Usage parser reads input and output tokens only; rate card has no cache or reasoning prices |
| Cache hit ratio | Not requested or recorded |
| Cost per agent, campaign, task class or tool | Reservations carry category and run key, but no agent, campaign or task attribution |
| Tool-call count and error rate per run | Not persisted outside the run loop |
| Model-call count per chat run | Derivable only by counting reservations per run key |

## SDK version at baseline

`openai` npm package upgraded from 7.17.0 to 7.25.0 on 2026-09-30. The 7.18.0–7.25.0 changelog contains features (GPT-6 Sol/Luna and GPT-6.1 Sol identifiers, Agents API options, prompt-cache prewarming, webhook management) and fixes, with no breaking change to the Responses, Embeddings or Images calls Orbit uses. Lint, typecheck and 382 of 383 tests pass on Node 24.18.0; the one failure is the known local worker-lifecycle timeout, which also fails on the pre-upgrade commit `9e62a0b`.
