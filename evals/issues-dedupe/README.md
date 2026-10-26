# Issue duplicate detection eval (ADR 0018, WP3.7)

Offline and deterministic: no model call, no cost. `dedupe.test.ts` ranks the synthetic corpus in `pairs-v1.json` for each new report with `lexicalScore` (`apps/api/src/modules/issues/duplicates.ts`, stage 3 of plan §2.5) and keeps the candidates above the default `suggestThreshold` (0.35).

| Metric | Gate | v1 result (2026-10-26) |
|---|---|---|
| recall@5 of true duplicates (48 queries) | ≥ 0.8 | 1.000 |
| top-1 of true duplicates | ≥ 0.7 | 1.000 |
| unrelated reports with a suggestion (14 queries) | ≤ 0.2 | 0/14 |

The first run reached recall@5 0.792. The stemmer and the bilingual glossary were then extended using that run's misses (word forms such as trading/trade, German terms such as Auszahlung, gutgeschrieben, Ergebnisse). The v1 numbers are therefore optimistic. A held-out set with new phrasings (v2) should confirm them before any threshold change.

Stages 1 and 2 (exact fingerprint and external reference) attach reports without scoring and are covered by the integration tests. The vector and AI judge stages are not built in the MVP; the AI judge's precision gate (≥ 0.9 on `same_issue: yes`) applies once it exists and an eval run is approved.

Run it with the normal suite or alone:

```bash
./node_modules/.bin/vitest run evals/issues-dedupe
```
