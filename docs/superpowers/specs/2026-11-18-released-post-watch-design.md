# Released-post watch: early warning before a released post is lost

Date: 2026-11-18 · Owner: Mario · Status: draft for approval

## Why

On 2026-11-17 the FamilyPlan post "Dienstagabend: Android-Familien gesucht"
(FB `1a2863aa`, IG `5354f083`, slot 18:30 Berlin) was released by Mario at
09:45 and never published. At 15:08 Berlin the GitBook source `b1f4306e`
was re-read (74 documents, new content). That changed the knowledge corpus,
so the active index evaluation became invalid
(`INDEX_EVALUATION_CORPUS_CHANGED`). The publish preflight at the slot then
added `LIVE_RAG_EVAL_REQUIRED`, both publications became
`blocked_dependency`, and `syncSocialHolds` cancelled the held Social posts.
The same pattern blocked the 2026-11-12 posts.

Nothing told Mario in time. The existing `reportBlockedPost` notice fires
only at the slot (too late) and only reaches a linked Telegram bot; the
`blocked` bot kind is not mapped to a member notice. Between the re-read
and the slot there were 3 h 20 min, enough to evaluate and activate a new
index (about 0.12 USD on 2026-11-18).

Mario wants to learn **as early as possible** that a post he released will
not go out, so he can still act, and to be **warned before** a knowledge
action blocks released posts.

## Goals

- **B (watch):** A released post whose publication would be refused, or
  that was already blocked before its slot, produces a warning as soon as
  Orbit can know it: cause, slot, channels, and what to do. Covers every
  blocker, not only knowledge.
- **B (all-clear):** When a warned post becomes publishable again before its
  slot, a short all-clear follows.
- **C (before):** Before a corpus-changing knowledge action, the person sees
  which released posts it would block until a new index evaluation, and can
  cancel.

## Non-goals

- Loosening the `LIVE_RAG_EVAL_REQUIRED` release gate (e.g. letting posts
  whose own facts are unchanged pass). That is a separate safety decision.
- Fixing the cause automatically (no automatic index build, evaluation or
  activation, no paid calls).
- Changing slot-time behaviour: the slot preflight, `reportBlockedPost` and
  Social's cancellation of held posts stay as they are.
- Re-scheduling or reviving blocked posts.

## Anti-goals (a failure even if it works)

- Repeated notices for the same unchanged problem (every watcher tick).
- Warnings for blocks the owner caused (`VETOED`, `PROJECT_PAUSED`), for
  test publications, or for posts nobody released.
- The watcher writing to the publication record (version bump, package hash
  or idempotency side effects) or making paid/external calls.
- A confirmation dialog that cries wolf: shown when no released post depends
  on the gate, or when the gate is already invalid anyway.

## Constraints

- Module boundaries (`scripts/boundaries.json`): the knowledge module and
  `packages/knowledge` must not import marketing. Knowledge reaches modules
  only through registered contributions (pattern: `knowledgeImpact` in
  `apps/api/src/platform/modules/contributions.ts`).
- Notifications go through existing platform paths: `notifyMembers`
  (in-app bell + e-mail; on in production, e-mail enabled) and the
  Telegram `notify` (no-op without a linked bot). Kinds are registered by
  the module (`userNotifications`, `notifications`).
- `preflight` (`apps/api/src/modules/marketing/policy/policy.ts:481`) is
  read-only for UI previews (no audit; `aiLabelBlocker` with `audit:false`),
  local only, no paid calls.
- No schema change and no migration (a new entity kind in the generic
  `entity` table is fine).
- New behaviour ships behind a flag, default off, per project practice;
  enabling it in production is Mario's decision.

## Approaches considered

1. **Watcher (chosen).** A periodic marketing task runs the publish
   preflight ahead of time for every released, pending post and warns on a
   new blocker. Covers every cause, including future ones; costs repeated
   read-only checks, bounded by a horizon and a cap.
2. **Events.** Each known cause (index invalidated, content changed, policy
   saved, account disconnected, …) reports itself. Immediate and cheap, but
   every new cause must be wired in; a forgotten one fails silently again,
   which is what happened on 2026-11-17.
3. **View only.** Show the risk on Home and Approvals, no bell or e-mail.
   Least work, but invisible unless Orbit is open; does not meet the goal.

Mario chose 1 (2026-11-18). C is the same under 1 and 2.

## Design

### B — the watcher

**Where:** a new `PeriodicTask` in `apps/api/src/modules/marketing/periodic.ts`
(name e.g. `released-post-watch`), next to `social-hold-sync`, implemented
under `apps/api/src/modules/marketing/publishing/`.

**Which posts:** every live (`test !== true`) Marketing publication waiting
for a future slot: owner-released assignment posts (`ownerReleasedAt`),
veto-window posts (`vetoDeadline`), and posts approved in Marketing
approvals and scheduled without an assignment (under `human_each` a
pending publication exists only after the owner's exact approval). My call:
broader than `reportBlockedPost`, and independent of `agentsEnabled()`,
because Goal B is "any post Mario released". The watcher checks those
within a horizon (my call: 48 h), at most 20 per run, nearest slot first.
Native Social posts (origin `manual`/`mcp`) are out of scope: they do not
pass the Marketing preflight, and Social already reports account problems
(`social_account_reconnect`).

**Veto-window posts:** evaluated as they will stand once the window ends.
While the window is open, codes that the window's end clears
(`APPROVAL_REQUIRED`, `MISSION_*_NOT_AUTHORIZED` from `releasedByVeto`
comparing against `Date.now()`) are not warnings; every other blocker is.
A stop during the window is the owner's own act (`VETOED`) and is ignored.
My call; the builder may evaluate with the veto treated as passed instead
of filtering codes, whichever is cleaner in `preflight`.

**What counts as at risk:**

- status `intent_created` and `preflight(..., { test: false, at: slot,
  approvalPublicationId })` returns blockers; or
- status `blocked_dependency` before the slot (e.g. `CONTENT_CHANGED`,
  `fact_changed`), not vetoed.

Ignored: `OWNER_CAUSED` codes (`VETOED`, `PROJECT_PAUSED`), and any code
that is expected before the slot and clears by itself at the slot (the
builder lists these from the preflight code paths; evaluating at the slot
time is meant to avoid most of them).

**When it runs:** any write in the project wakes it (as with
`social-hold-sync`), so a knowledge re-read is checked within one worker
pass. Without writes, `nextDueAt` returns the earlier of "now + 15 min" and
the next slot while at least one post is in the horizon, and `null`
otherwise.

**State and de-duplication:** the watcher keeps its own record per
publication in a new marketing entity kind (e.g. `publication_watch`):
current blocker codes (sorted), first seen, last notified codes, all-clear
sent. It never writes the publication. A warning is sent only when the
code set differs from the last notified set; an all-clear only after a
warning and when the post is publishable again. Notice dedupe keys include
the publication id and a hash of the code set, so a retried run sends
nothing twice. Records of posts past their slot may be deleted or kept;
the builder decides (they are content-free).

**The notice:**

- Member notice (bell, e-mail default on): new marketing user kind, e.g.
  `marketing_post_at_risk` ("Ein freigegebener Post wird nicht
  veröffentlicht" / "A released post will not be published"), and
  `marketing_post_at_risk_cleared` for the all-clear (e-mail default off).
  Recipients: the project's owners (the releaser is an owner).
- Telegram: a new bot kind with its renderer in the existing marketing
  notification messages, sent through `notify` (no-op without a bot).
- Content: post title, local slot time and time zone, channels, each
  blocker with cause and fix from `readiness/blocker-catalog.ts` in the
  project language, and a link to the approval/post (Marketing approvals,
  or the assignment detail for assignment posts). No post body in e-mail
  beyond the title (content-free audit and mail stay the rule).
- Audit: one content-free record per warning (`publication.at_risk`) with
  codes, publication id and assignment ids, mirroring
  `publication.claim_blocked`.

**Interplay:** the slot-time `reportBlockedPost` notice stays. It reports a
different event (the post did not go out). Agent activity keeps its
`POSTS_BLOCKED` health issue.

### C — warning before a knowledge action

**Contract:** a new optional module contribution (beside
`knowledgeImpact`), e.g. `releaseGateDependents(tx, scope)`, returning the
released, pending, non-test posts whose publication depends on the live
index evaluation: id, title, local slot, channels. Marketing implements it
with the watcher's selection rule but **without the horizon and cap**: the
gate blocks every live publication, so a post due in three days counts
too (my call). The platform aggregates across modules.

**Endpoint:** a read route in the knowledge module, e.g.
`GET /api/projects/:projectId/knowledge/release-impact`, returning
`{ gateValid, count, dependents }`. Both are empty when the gate is already
invalid (the posts are blocked anyway and the watcher has warned).

**Who sees what (my call, the conservative option):** the route needs the
same permission as the corpus-changing actions it guards. `count` is
always returned; `dependents` (titles, slots, channels) only when Marketing
is active in the project and the caller passes the Marketing module-role
check (`docs/MODULE_ACTIVATION.md`). Otherwise the dialog says "Das sperrt
2 freigegebene Marketing-Posts …" without naming them. Access-matrix
fixture changes for this route are reviewed as security changes.

**UI:** before each corpus-changing action in the Knowledge UI, the client
asks the endpoint; when `gateValid` and `dependents` is non-empty it shows
a confirmation: "Das sperrt 2 freigegebene Posts (heute 18:30, FamilyPlan
FB + IG), bis ein neuer Index bewertet und aktiviert ist." with
"Trotzdem einlesen" / "Abbrechen". Otherwise the action runs as today.
Actions in scope: "In Inhalt einlesen" (source read-in), adding/importing a
document or URL, re-versioning, and removing or withdrawing a source or
document. The builder confirms the list against what changes the index
manifest (`manifest()` in `packages/knowledge/src/indexes.ts`).

**MCP and Assistant:** knowledge write tools (`knowledge_import_url`,
`knowledge_add_document`, `knowledge_add_source`, and the Orbit Assistant /
MCP 2.0 paths that reuse them) cannot show a dialog. My call: their result
carries a `releaseImpact` warning (same data and visibility rule) and the
watcher's notice follows; no new confirmation parameter, so existing
clients keep working.

**Automatic corpus changes** (GitHub sync and site crawl runs, a source
expiring, source `modelUse`/`authority`/`status` changes made by jobs) have
no person to ask beforehand. My call: they rely on the watcher's notice,
which follows within one worker pass. Interactive edits of a source's
`modelUse`, `authority` or `status` in the Knowledge UI are in scope for the
dialog.

## Flag and rollout

- One flag, e.g. `ORBIT_RELEASED_POST_WATCH`, default off, covering B and
  C. Off: no task, no route answer beyond "off", no dialog.
- Enabling in production: Mario. No schema change, so no new schema hash.
- First live check: release a post, change the corpus (or wait for a real
  re-read), confirm the bell + e-mail arrive within one worker pass, then
  activate a new index and confirm the all-clear.

## Testing (builder fills in)

- Unit: selection (released/veto, test, horizon, cap), code-set
  de-duplication, all-clear, owner-caused codes ignored.
- Integration: corpus change after release → one warning; a second tick →
  none; index activated → all-clear; content invalidation before slot →
  warning; test publication → none; project without the flag → nothing.
- Boundaries: `pnpm` boundary check stays clean (no knowledge → marketing
  import).
- Access: notices only to owners of the project; another project's posts
  never appear in `release-impact` (cross-project negative test).
- Web: the confirmation dialog shows only with dependents; e2e for the
  read-in flow.

## Left to the builder

- Exact names of the task, kinds, flag, entity kind and route.
- The list of pre-slot codes that clear by themselves.
- Whether to cache preflight results per content version and index.
- Cleanup of watch records after the slot.
- Message wording within the content above (German and English).

## Calls I made (Mario to check)

- Watch every live Marketing publication you approved (assignment,
  veto-window and hand-scheduled), not only assignment releases; native
  Social posts out of scope.
- The "before" dialog counts all released future posts (no horizon).
- Post details in the dialog only for people with Marketing access;
  others see a count.
- Automatic syncs and expiries get the watcher's notice only, no "before".
- Veto-window posts: no warnings for codes the window's end clears.
- Horizon 48 h, cap 20 posts per run, 15-minute fallback interval.
- E-mail on by default for the warning, off for the all-clear.
- Recipients: project owners only.
- One flag for B and C, default off.
- MCP gets a warning in the result, not a confirmation step.
