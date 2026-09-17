# ADR 0003: Atomic cost reservations

Costs use integer micro-units of configured account currency. A per-project transaction lock serializes reservations and channel slot allocation across queue workers. Budget policy has daily, monthly and per-run maxima; rate cards specify input/output micro-units per million tokens and verification timestamp. Missing/old prices fail closed. Text, embeddings, query and reindex operations have separate categories. Timeout costs stay unknown and charged against reservation until reconciled. Actual usage is stored only from the provider response; test jobs are labeled synthetic and do not pretend to consume live tokens.

Owner mandates currently express one currency per deployment (the OpenAI billing currency); imported campaign monetary values retain separate explicit ISO currencies and must never be silently summed across currencies.
