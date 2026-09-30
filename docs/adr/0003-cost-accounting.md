# ADR 0003: Atomic cost reservations

Costs use integer micro-units of configured account currency. A per-project transaction lock serializes reservations and channel slot allocation across queue workers. Budget policy has daily, monthly and per-run maxima; rate cards specify input/output micro-units per million tokens and verification timestamp. Missing/old prices fail closed. Text, embeddings, query and reindex operations have separate categories. Timeout costs stay unknown and charged against reservation until reconciled. Actual usage is stored only from the provider response; test jobs are labeled synthetic and do not pretend to consume live tokens.

Owner mandates currently express one currency per deployment (the OpenAI billing currency); imported campaign monetary values retain separate explicit ISO currencies and must never be silently summed across currencies.

## Addendum 2026-09-30: cache-aware settlement

Rate cards gain optional `cachedInputMicrosPerMillion` (default: input rate) and `cacheWriteMicrosPerMillion` (default: `ceil(1.25 x input rate)`). Settlement is `ceil((ordinary x input + cached x cachedInput + cacheWrite x cacheWriteRate + output x outputRate) / 1,000,000)` with a minimum of 1 micro, where `ordinary = input_tokens - cached_tokens - cache_write_tokens` and reasoning tokens stay inside output tokens.

Unknown details rule: when the provider usage object omits the cached/cache-write split, all input settles at `max(input rate, cache-write rate, cached-input rate)`; a detail object or count that is `null` counts as omitted; usage is never assumed free. Cached plus cache-write tokens above input tokens (`USAGE_INCONSISTENT`) or an unreadable usage object (`USAGE_UNKNOWN`) leave the reservation unknown and counted. Estimates charge all input at the cache-write rate, so reservations are conservative by up to about 25 % of the input part. Existing fail-closed price errors are unchanged.

Reservations additionally carry nullable `agentRunId`, `taskClass`, `model` and `missionId` so cost can be grouped without changing budget enforcement. Telemetry spans mirror, but never replace, the reservation ledger as the cost source of truth.

Rollout note: the higher cache-aware estimate changes the first-draft ceiling that Chat stores with a proposal. Chat proposals still pending when this phase deploys fail confirmation with `PROPOSAL_COST_CHANGED` (the stored `firstDraftMaxMicros` is lower than the recomputed ceiling), and missions confirmed before the deploy but generated after it can hit `CHAT_PROPOSAL_COST_EXCEEDED` earlier. Nothing is overspent: the checks fail closed before any paid call. Re-create (propose again) or confirm pending proposals before deploying; afterwards the recovery is to propose again. The runtime checks are deliberately unchanged.
