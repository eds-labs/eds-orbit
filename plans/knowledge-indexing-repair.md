# Knowledge indexing and RAG search repair

Status: implemented 2026-10-23 on branch `claude/knowledge-indexing-repair`. Decisions by Mario on 2026-10-23: MCP reads require only `modelUse`, and the FamilyPlan source is reclassified as `official`.

## Symptom

FamilyPlan (project `118371ad-…`) imported 12 Markdown documents through the MCP tool `knowledge_add_document` into the manual source `7179fa92-…` (*FamilyPlan – Kuratierte Projektwissensbasis 2026-10*): 12 documents, 84 chunks, `embedded: 0`. MCP `search` returned nothing, even for simple words.

## Findings (production data checked read-only on 2026-10-23)

- All 12 documents are active, in German (the project language) and on source generation 1. There is one active embedding index (generation 1, `openai:text-embedding-3-small:1536:chunk-v1`) and no embedding jobs.
- The source has `status: active`, `modelUse: true`, `publicUse: false`, **`authority: generated`** and `maxAgeHours: 168`.

## Root cause

1. **`authority: generated` (blocking, all searches).** `retrieve` and `eligiblePassages` exclude generated sources from every search (`generated_derived`). This follows the base rule that generated content is never evidence. The source was registered as generated, but no tool response, receipt or UI said that its documents could not be found.
2. **`publicUse: false` (blocking, MCP and assistant).** MCP `search`/`fetch` used `purpose: "public"` (the WP-M3 eligibility rule), which requires the public right. With (1) fixed, MCP would still have returned nothing.
3. **`embedded: 0` is expected, not the cause.** `knowledge_add_document` never buys embeddings: they need the separate, mandate-bound `embed-document` job. Full-text (lexical) retrieval works without embeddings. The paid hybrid path only adds semantic ranking when a spend mandate allows it.
4. **Latent: documents are hidden after any source settings change.** `setSourceRights` (rights, pause/resume) bumps the source generation. Stored versions stayed on the old generation and vanished from search with `reindexRequired: true`, and no code ever did that reindex. A manual or uploaded source has nothing to sync from, so a single pause and resume made it permanently unsearchable.
5. **Latent: freshness of manual sources.** With `maxAgeHours: 168`, the FamilyPlan documents (imported on 2026-10-20) would have dropped out of search on 2026-10-27. Nothing made this visible, and there was no way to change the window.
6. **No visibility.** MCP `search` logs a project's `KnowledgeError` but returns an empty list. Neither the admin UI nor the MCP tools showed whether a source can be found or why not.

## Changes

- **Engine (`packages/knowledge`)**
  - `setSourceRights` also changes `authority` and `maxAgeHours` (validated and audited, with the names of the changed settings).
  - `restampSource` moves outdated active versions to the current generation. Text, language, validity and import time stay the same, so freshness is not extended. Chunks are cut fresh, embeddings of identical chunks in the active index are carried over, and the old version is superseded. The function is idempotent, and parallel runs are serialized by the project advisory lock.
  - `sourceIndexStatus` reports per source the state (`pending`, `indexing`, `ready`, `failed`, `stale`), blockers (`generated_authority`, `source_paused`, `model_use_forbidden`, `outdated_generation`, `stale_documents`, `no_documents`), documents, chunks, embedded chunks, search mode (`hybrid`/`lexical`/`none`), last import time and pending/failed jobs with the last error.
  - `validateEvidence` checks the public right and the embargo only for public evidence. Internal evidence is never "public-ready", so it can never serve marketing or support.
- **Platform:** `setSourceRights` always re-attaches the source's documents. `knowledgeIndexStatus` passes the job records to the engine (the engine names no other module's entity kinds).
- **MCP:** `search` and `fetch` read with `purpose: "internal"` (model right required, public right and embargo not; generated, paused, revoked, stale, other-language and other-project content stay excluded). Facts follow the same rule (`FactQuery.purpose`). `knowledge_sources` shows each source's index state, and the `knowledge_add_document` receipt says whether the document can be found.
- **Unchanged rights:** marketing generation, the Orbit assistant's `knowledge_search` and support drafts still search `public` (public and model right).
- **Actions (owner only, two new access-matrix rows; no existing cell changed):**
  - `source-settings` changes authority and/or freshness window and reindexes.
  - `source-reindex` runs the idempotent backfill.
- **Admin UI:** Knowledge → Sources shows a state badge per source. The inspector shows counts, search mode, last import, jobs, blockers and the last error, plus *Reindex* and *Source settings* for owners.

## Operations

- **FamilyPlan restore, after deploy, owner:** Knowledge → Sources → *FamilyPlan – Kuratierte Projektwissensbasis 2026-10* → *Source settings*: authority `official`, freshness window `8760`. This is one action: generation 2, all 12 documents re-attached, no new import and no duplicates. The API equivalent is `POST /api/projects/{id}/actions/source-settings {sourceId, authority, maxAgeHours}`.
- **Other projects:** a source that was paused/resumed or had its rights changed before this release shows `outdated_generation`. *Reindex* (`source-reindex`) restores it free of charge.
- **Embeddings (optional, paid):** `embed-document` per document, under the project's spend mandate. For FamilyPlan, 84 chunks with text-embedding-3-small cost well below USD 0.01. This needs an active policy with a budget. Without one, search stays full-text (`searchMode: lexical`), which the status says openly.
- **Rollback:** redeploy the previous image. The schema is unchanged, and restamped versions are ordinary versions.

## Follow-ups

- Verified facts of a source whose generation changed stay on the old generation and drop out of search, as before. They need re-verification, and the status does not count them yet.
- `knowledge_add_source` still defaults to `maxAgeHours: 168` for manual sources; a longer default for manual/file sources would avoid the stale trap.
