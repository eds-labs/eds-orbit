# Orbit Core — merge and rollout plan

**Status:** PROPOSED on 2026-10-02 for Mario's decision. This plan executes nothing by itself. Every step marked **Approval** needs Mario's explicit go for that step, in line with `AGENTS.md` (production deployments, paid calls, live posts, feature flags with production effect).

Scope: the Orbit Core stack from [ORBIT_CORE_JARVIS_PLAN.md](ORBIT_CORE_JARVIS_PLAN.md) and [ORBIT_CORE_J3_SCHEDULING_PLAN.md](ORBIT_CORE_J3_SCHEDULING_PLAN.md), pull requests #31–#49 except #33 and #37.

## 1. Facts this plan relies on (checked 2026-10-02)

| Fact                                                                                                                                                                                                                     | Consequence                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `main` is at `9c46b0d` (#30), the base of #31.                                                                                                                                                                           | The stack applies without conflicts.                                                      |
| Every PR from #31 to #49 is open, mergeable and stacked linearly (#31 → main, #32 → #31, #34 → #32 … #49 → #48). CI (`validate`, `isolated-acceptance` incl. Playwright) was green on each PR that has finished its run. | The head of #49 (plus this document) contains the whole stack.                            |
| #33 (S1 runtime port) and #37 (S2 SDK spike, no-go) branch off #31 and are not in the stack.                                                                                                                             | They are decided separately (section 6).                                                  |
| The stack changes nothing under `packages/db/prisma`: **no migration**.                                                                                                                                                  | The previous image stays compatible with the schema; rollback is a redeploy of `9c46b0d`. |
| Coolify deploys every push to `main` through the GitHub webhook (`docs/deployment/COOLIFY.md`).                                                                                                                          | Merging 17 PRs one by one into `main` would cause up to 17 production deployments.        |
| Repository settings: merge commits, squash and rebase allowed; head branches are not deleted on merge.                                                                                                                   | Stacked PRs are not retargeted automatically.                                             |
| New configuration: `ORBIT_CONTENT_PACKAGES`, `ORBIT_TOOL_SEARCH`, both default `false`.                                                                                                                                  | Most new behaviour stays off after the deploy.                                            |
| The $5 paid budget of decision D3 (2026-09-30) covered only the Phase 2 model comparison.                                                                                                                                | Every paid acceptance step below needs its own budget approval.                           |
| The SDK no-go record (ADR 0005 addendum, spike evidence) existed only on #33's branch.                                                                                                                                   | Carried into the stack with this plan (section 6).                                        |

## 2. What changes in production on deploy, even with both flags off

| Change                                                                                            | PR            | Effect right after deploy                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat jobs run with the requesting user's **current** project role                                 | #31           | A removed or demoted member's queued chat job stops with `ACTOR_MEMBERSHIP_REQUIRED`. Intended.                                                                                                                                      |
| Action requests, decide route, owner approvals inbox                                              | #32, #34, #40 | Inbox appears only when owner decisions are open; none exist before packages are used.                                                                                                                                               |
| Worker queue class `image`                                                                        | #32           | The worker consumes one more queue; idle without approved image requests.                                                                                                                                                            |
| **Weekly autopilot skips days that scheduled publications already fill** (daily quota or spacing) | #44           | Not behind a flag. A manual or other scheduled post on a day the autopilot has not yet planned now stops that day's paid autopilot draft (audit `autopilot.slot_skipped`); before, the draft was made and then blocked by the quota. |
| Cancel route for a package post's schedule                                                        | #46           | Only reachable for package posts; works without the flag by design.                                                                                                                                                                  |
| Everything else (packages, images in posts, scheduling, history, slots, tool search)              | #34–#49       | Off until the flags are set.                                                                                                                                                                                                         |

## 3. Merge strategy (recommended: one integration PR)

**Recommendation:** merge the whole stack into `main` through one integration pull request from the top of the stack, with a merge commit, inside the approved deployment window. One merge means one deployment, one image to verify and one rollback point (`9c46b0d`).

1. Open a pull request from the top branch (`claude/orbit-core-rollout-plan`, which contains #31–#49 and this plan) to `main`. Its description lists #31–#49 as the reviewed parts.
2. Let CI run on that PR; it must be green (`validate`, `isolated-acceptance`).
3. **Approval A (merge = production deploy):** merge it with a merge commit (no squash, so the per-PR commits and their review history stay traceable), in the window agreed in section 4.
4. After the merge, close #31–#49 with a comment "merged via #<integration PR>" (#31 may be marked merged by GitHub automatically). Delete the head branches afterwards, except #33 and #37 until section 6 is decided.

Alternatives considered:

- Merging bottom-up PR by PR into `main`: keeps GitHub's merged state per PR, but deploys up to 17 times and needs each PR retargeted to `main` by hand. Only acceptable with the Coolify auto-deploy paused, which is itself a production configuration change.
- Squash merge: loses the commit trail the plans and ledgers reference by hash. Not recommended.

## 4. Rollout phases

Each phase starts only after the previous one is verified. "Owner" means Mario.

### Phase 0 — preparation (no production effect)

- [ ] CI green on the integration PR.
- [ ] Latest encrypted off-host backup succeeded within the last 26 hours (`orbit-backup ok`, Coolify scheduled task) and the `CREDENTIAL_KEY` escrow is current (`docs/BACKUP_RESTORE.md`).
- [x] **Approval B — skipped by Mario on 2026-10-03.** Reason: the skip only stops autopilot drafts for days whose daily quota or spacing is already used by a scheduled post; such a draft would have been blocked at handoff by `CHANNEL_DAILY_QUOTA` or `CHANNEL_SPACING` anyway. The preview was informational. Skipped days show up after the deploy as `autopilot.slot_skipped` audit events. For reference, the step was: run the two queries from the [Phase 0 runbook](#appendix-phase-0-runbook): the context (timezone, autopilot plan moment, posting times, policy) and the preview of every channel-day the deployed autopilot will skip (`will_skip`). Confirm each `will_skip = true` row, or cancel the publication behind it before the deploy.
- [ ] Rollback target: the integration merge commit on `main` (its first parent is `9c46b0d`). Rolling back needs no Coolify lookup: `git revert -m 1 <merge commit>` pushed to `main` makes Coolify deploy the previous state, and with no migration the schema stays compatible. Coolify's own "redeploy previous deployment" is an equivalent alternative.
- [ ] Agree the window: outside the uLiquid posting times and not at the weekly autopilot plan moment.

### Phase 1 — deploy with both flags off

- [x] **Approval A:** merge the integration PR (section 3); Coolify deploys it. Done: Mario approved on 2026-10-03; #51 merged at 16:27:46 UTC after both required checks passed (merge commit `c3a1d07`); #31–#50 closed with a reference to #51, #33 and #37 kept open.
- [x] Verify: `migrate` completed with no pending migration; API, worker and web healthy; worker heartbeat current; authenticated browser login; Operations queues show no growing backlog. Done 2026-10-03: new code answering from 16:32:11 UTC (the new `action-requests` route returns 401 instead of 400); `/api/health/ready` reported database and worker `ok`, `/api/health/postiz` `ok`; Mario confirmed login. Coolify logs and the `migrate` step were not inspected (no migration in the stack).
- [ ] Verify unchanged behaviour (chat confirmed by Mario on 2026-10-03; autopilot handover still to observe): one ordinary Orbit Chat question succeeds; the autopilot plan check runs (every ten minutes) without `AUTOPILOT_PLANNING_BLOCKED`; `autopilot.slot_skipped` appears only for the days approved in Phase 0; scheduled autopilot posts are handed over as before.
- [ ] Observe at least until the next autopilot post has been handed over and reconciled.

Rollback: revert the integration merge on `main` (`git revert -m 1 <merge commit>`, push; Coolify deploys it), or redeploy `9c46b0d` in Coolify. No data repair is needed; no package data exists yet.

### Phase 2 — content packages, drafts only

Finding on 2026-10-05, before Approval C: `docker-compose.yml` passes environment variables to the containers by name, and the two feature flags were missing, so a value set in Coolify would not have reached API or worker. Fixed in the pull request after #51: both flags are passed to API and worker with default `false`, checked by `pnpm test:coolify-compose`. That merge deploys with the flags still off; Approval C follows after it.

- [ ] **Approval C (flag + paid drafts):** set `ORBIT_CONTENT_PACKAGES=true` in Coolify and redeploy (the flag is read from the environment; it applies to every project on this instance). Paid drafts stay inside the existing uLiquid policy budget; each package shows its cost ceiling before the start click.
- [x] Approval C done on 2026-10-05: `ORBIT_CONTENT_PACKAGES=true` set for the Production environment in Coolify and redeployed (`ce491a6`, manual redeploy successful); the package card appears in chat.
- Phase 2 findings on 2026-10-05:
  - `FACT_CONFLICT`: about 50 uLiquid Verified Facts exist twice with identical values (imported on 2026-09-18 at 12:31 and again at 12:43, both `verified`), for example `url.beta_registration`. A package refuses a key with two usable facts instead of guessing. Keys that exist once, such as `product.beta_access.status`, work. Decided by Mario on 2026-10-05: a package now treats copies with the same statement (value, type, unit, currency, language) as one fact and uses the newest copy; copies with different values still block with `FACT_CONFLICT`. Withdrawing the older copies remains an optional cleanup.
  - `CHAT_FAILED` with `product.beta_access.status`: the uLiquid profile audience has 408 characters, a mission allows 300; the package passed it unshortened and mission validation failed. Fixed in the pull request after #52 (shortened like the autopilot), and invalid package input now returns `PACKAGE_VALIDATION_FAILED` with the invalid fields instead of `CHAT_FAILED`.
  - `LINK_NOT_ALLOWED` after both fixes (2026-10-05): the first official link in the uLiquid profile is `https://uliquid.vip`, while the policy allows only `https://desk.uliquid.vip`. Packages and the weekly autopilot always used the first link, so packages failed and **all 14 autopilot generation jobs were blocked with `LINK_NOT_ALLOWED`; the autopilot had produced no draft and no publication**. A new policy version that also allows the website was refused by Orbit's live readiness check (`CURRENT_PUBLIC_KNOWLEDGE_REQUIRED`: no public source synced within its maximum age), so nothing changed. Fixed in code: packages and the autopilot now use the first official link the active policy allows, and a package prefers the link whose fact it states (for example `url.beta_registration`); when no official link is allowed, the autopilot records `AUTOPILOT_PLANNING_BLOCKED` instead of planning drafts that cannot run. Missions planned before the fix keep their stored link and stay blocked; days planned from then on use the allowed link. Open decision for Mario: whether posts should link the website (refresh the public sources, then a new policy version that allows `https://uliquid.vip`).
  - Knowledge and policy repair on 2026-10-05, approved by Mario step by step: the website source was re-imported (new document version 2, 44 chunks); index generation 3 was built and evaluated with `evals/knowledge/uliquid-website-2026-10-05.v1.json` (68 cases prepared by Claude and confirmed by Mario: 54 expected-evidence, 14 negative safeguards; recall@10 1.0, MRR 0.96, 0 forbidden hits, provider cost 54 micro-USD) and activated; a new policy version allowing `https://uliquid.vip` and `https://desk.uliquid.vip` was saved; the 13 blocked autopilot generation jobs were retried and produced 13 drafts that wait for the owner's review (`HUMAN_CONTENT_REVIEW_REQUIRED`), nothing published.
  - Package drafts still stopped with `EVIDENCE_INVALID`: package missions did not use their exact fact keys, so retrieval matched 21 facts by key words in the goal and hit the fact context limit. Fixed in the pull request after #55.
  - Retest after #56 (2026-10-05): the package card and the start worked and both drafts were created (no `EVIDENCE_INVALID`), but both read "uLiquid Desk | Beta access / open / Request beta access" and failed review with `FACT_VALUE_MISMATCH`. The value of `product.beta_access.status` is the single word `open`; the draft instruction placed every text fact as a whole sentence and Orbit replaced the claim with the bare value, which claim review rightly rejects because it names no subject. Fixed in the pull request after #56: a single-word value is written in a short clause naming its subject (for example "Beta access is open") and that clause is the claim; longer values are unchanged.
  - Acceptance after #57 (2026-10-05/06, run by Claude in the owner's browser on Mario's request, each package with the $0.62 ceiling, nothing published or scheduled for publishing):
    1. JC01 passed: one package card for X and Telegram with the ceiling; nothing ran before "Paket starten".
    2. Start passed: both drafts "Beta access is open. Request beta access" with "Prüfung bestanden".
    3. JC05 passed: "für nächste Woche Dienstag" planned both channels on 2026-10-13 (17:00 and 10:00, marked as not published); the drafts were written right after the start and wait for owner review (`HUMAN_CONTENT_REVIEW_REQUIRED`, free text).
    4. Revision passed: "etwas einladender" for uLiquid Desk changed only that draft ("1× überarbeitet", owner review required for the new free text); the other draft stayed unchanged.
    5. Cancel not shown: both drafts of the second package were finished about ten seconds after the start, before "Paket abbrechen" could be clicked; afterwards the card no longer offers a cancel. Cancelling before the start was shown earlier (card "Abgebrochen").
- [ ] Scripted acceptance in production by the owner (no publishing in this phase):
  1. JC01: "Erstelle einen X- und einen Telegram-Post über <aktueller verifizierter Fakt>, nichts veröffentlichen." → one package card with the ceiling; nothing runs before "Start package".
  2. Start it → two drafts, automatic review shown; spend recorded under `package:<id>` and below the ceiling.
  3. JC05: a request "für nächste Woche" → planned slot next week, drafts start now.
  4. Revision of one draft ("kürzer") → only that channel changes.
  5. Cancel a second, just-started package → the card reports what stopped.
- [ ] Record the actual spend per step next to the acceptance rows (`docs/REQUIREMENTS_TRACEABILITY.md`).

Rollback: set the flag to `false` and redeploy; started packages finish as draft-only missions. Cancel pending packages first if the image queue should drain.

### Phase 3 — package image (optional)

- [x] **Approval D (paid image):** one owner package with an image brief (ceiling shown on the card). Approve the usage rights on the card, attach the image to one draft, check the new review. Telegram drafts above 1,024 characters are refused by design.
- Phase 3 record (2026-10-06, Approval D given by Mario): one X package with an image brief, card ceiling $1.47 (image at most $1.00). The draft "A moment to pause. / AI assists. You decide. / Request beta access" waits for owner review (free text). The image (abstract blue chart, hand at keyboard, no text, logos or identifiable person) was generated; Mario approved its usage rights himself on the card; Claude attached it to the X draft ("Mit Paketbild"), and the new review reports only `HUMAN_CONTENT_REVIEW_REQUIRED`. Nothing published. Finding: after the rights approval the image badge still read "Erzeugt, Rechteprüfung offen"; fixed in the pull request after #57 ("Erzeugt, Rechte bestätigt").

### Phase 4 — tool search

- [ ] **Approval E (paid check + flag):** with the configured chat route on `gpt-5.4` or later, set `ORBIT_TOOL_SEARCH=true` and redeploy. Ask one question that needs a deferred tool ("Welche X-Slots sind diese Woche frei?").
- [ ] Verify in the run's spans: one `tool_search` span, then `schedule_options` succeeded; the answer lists slots. If the provider rejects `tool_search` (run fails with a model error), set the flag back to `false`; nothing else changes.

### Phase 5 — first live scheduled package post

Preconditions: Phases 1–2 verified; the target channel is write-verified for this publisher instance (and media-verified if the post carries the image); `EXECUTION_MODE=live` and external writes are already the approved production state for uLiquid; the policy window and channel allow the post.

- [ ] Choose a deliberate, low-risk post that the owner would publish anyway.
- [ ] "Plane den X-Post für den nächsten freien Termin" → a `content.schedule` request appears in the approvals inbox with the exact text, channel, time and "Öffentlicher Beitrag".
- [ ] **Approval F (public post):** the owner approves exactly that request in the inbox. Verify: one publication `intent_created`, the card shows "Terminiert", audit `mission.publish_authorized`.
- [ ] Before the slot, propose a second post and cancel it from the card → `withdrawn`/`canceled`, nothing sent.
- [ ] At the slot: preflight passes, the post is handed over to Postiz and published; reconcile the remote ID. Confirm no duplicate, and that the autopilot did not plan a draft for that day.

Rollback: cancel the schedule on the card before the handoff. After the handoff the post can only be removed in Postiz itself; Orbit reports it as not retractable and never resends.

### Phase 6 — normal use

- [ ] Two weeks of normal use with the checks in section 5.
- [ ] Then decide: keep both flags on permanently, and whether to remove the flag-off tool path (the 7,000-byte guard on the full tool set stays binding until then).

## 5. Monitoring during and after the rollout

| Signal                                                                                | Where                    | Expected                                  | Action if not                                                             |
| ------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------- |
| Worker heartbeat, queue backlog                                                       | Operations page, Coolify | Heartbeat current, no growing backlog     | Stop rollout; check worker logs (`Orbit queue pump unavailable (<code>)`) |
| Exceptions `PUBLISH_PREFLIGHT_BLOCKED`, `PUBLISH_OUTCOME_UNKNOWN`                     | Exceptions, audit        | None for package posts                    | Reconcile; do not resend                                                  |
| `autopilot.slot_skipped`                                                              | Audit                    | Only days with an intended scheduled post | Cancel the unintended publication; the next plan check plans the day      |
| Package spend under `package:<id>`                                                    | Budget journal, card     | ≤ shown ceiling                           | Stop; flag off                                                            |
| `action_request.*`, `content_package.*`, `publication.withdrawn`, `mission.publish_*` | Audit                    | Each owner decision recorded once         | Investigate before the next decision                                      |
| Backup heartbeat                                                                      | Coolify scheduled task   | `orbit-backup ok` daily                   | Fix before Phase 5                                                        |

## 6. Branches outside the stack

- **#37 (S2 SDK spike):** stays a draft reference PR, as decided on 2026-10-02; never merged. Its no-go record (ADR 0005 addendum and `docs/evidence/agents-sdk-spike-2026-10-02.md`) was only on #33's branch and is now carried into the stack with this plan, so it reaches `main` independently of #33.
- **#33 (S1 runtime port):** Mario decided on 2026-10-02 to keep the port and the legacy adapter. It is not part of this rollout because it branches off #31 and moves the chat turn loop, which the stack has changed since (package instructions, content packages, tool search). **Plan:** after Phase 2, rebase #33 onto the new `main` as its own pull request, carry the stack's loop changes into `runtime/legacy-responses.ts` and `chat-runner.ts`, and keep the chat-runner, tool-search and runtime contract suites green. It is a behaviour-preserving refactor; it deploys like any merge to `main` and needs its own **Approval G**.

## 7. Approvals summary

| ID  | Step                                                        | Production effect                               | Cost                                                      |
| --- | ----------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| A   | Merge the integration PR (= Coolify deploy)                 | New code live, flags off; autopilot skip active | none                                                      |
| B   | Read-only query of active non-autopilot publications        | none                                            | none                                                      |
| C   | `ORBIT_CONTENT_PACKAGES=true` + scripted package acceptance | Package drafts for all projects on the instance | paid drafts within the policy budget and package ceilings |
| D   | One package image                                           | One generated image (reference asset)           | ≤ image ceiling                                           |
| E   | `ORBIT_TOOL_SEARCH=true` + one check                        | Fewer tools sent per chat call                  | one chat run                                              |
| F   | Approve the first live package post                         | One public post                                 | none beyond the drafts                                    |
| G   | Merge the rebased runtime port (#33) after Phase 2          | Refactor of the chat loop, no behaviour change  | none                                                      |

## 8. Rollback summary

| From                   | How                               | Remaining effects to handle                                                                                                                                                                                                               |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any phase, code        | Redeploy `9c46b0d` in Coolify     | Before that: cancel scheduled package posts that must not go out (the old code has no cancel path and would publish them), cancel pending packages and image requests. Package data stays in the database and is ignored by the old code. |
| Phase 2–5, feature     | Set the flag to `false`, redeploy | Started packages finish as drafts; approved schedules stay ordinary publications and can still be canceled from the card.                                                                                                                 |
| Phase 4                | `ORBIT_TOOL_SEARCH=false`         | none                                                                                                                                                                                                                                      |
| Phase 5, after handoff | Remove the post in Postiz         | Orbit records the outcome; it never retracts or resends.                                                                                                                                                                                  |

## Appendix: Phase 0 runbook

Everything here is read-only. Nothing is printed that contains a secret; the database password stays inside the container.

### Step 1 — backup and key escrow

1. Coolify, Orbit application, Scheduled Tasks: the last run of `orbit-backup once` succeeded less than 26 hours ago. Alternatively the `backup` container log shows `orbit-backup ok` within that time, and its health is `healthy`.
2. Confirm in the password manager that the running `CREDENTIAL_KEY` and the `age` backup key are stored (`docs/BACKUP_RESTORE.md`, one-time setup).

### Step 2 — rollback target

Coolify, Orbit application, Deployments: note the current deployment ID and its Git commit (expected `9c46b0d`). On the host, note the API image digest without printing environment values:

```sh
docker inspect --format '{{.Image}}' <orbit-api-container>
```

### Step 3 — Approval B queries

The queries are versioned in `scripts/rollout/` and covered by `apps/api/tests/rollout-phase0.integration.test.ts`. That test checks that the preview predicts exactly the days the deployed `planAutopilot` skips (daily quota, spacing, already planned days, canceled posts), and that both queries run in a read-only transaction. They run in the Orbit `postgres` container as the database owner (`orbit_migrator`, which can read across projects). `default_transaction_read_only=on` makes the session refuse any write (SQLSTATE `25006`).

1. Find the uLiquid project ID (read-only):

   ```sh
   docker exec -i <orbit-postgres-container> env PGOPTIONS='-c default_transaction_read_only=on' \
     psql -U orbit_migrator -d orbit -v ON_ERROR_STOP=1 \
     -c 'SELECT id, name, timezone, mode FROM "Project" ORDER BY "createdAt";'
   ```

2. Context and preview, with the files from this repository revision piped in from a checkout (for example over SSH from the workstation):

   ```sh
   docker exec -i <orbit-postgres-container> env PGOPTIONS='-c default_transaction_read_only=on' \
     psql -U orbit_migrator -d orbit -v ON_ERROR_STOP=1 -v project_id=<project-uuid> \
     < scripts/rollout/phase0-context.sql
   docker exec -i <orbit-postgres-container> env PGOPTIONS='-c default_transaction_read_only=on' \
     psql -U orbit_migrator -d orbit -v ON_ERROR_STOP=1 -v project_id=<project-uuid> \
     < scripts/rollout/phase0-autopilot-skip-preview.sql
   ```

3. Read the preview. It lists the next 14 local days, a superset of the autopilot planning horizon, for the autopilot's channels that have active publications:
   - `already_planned = true`: the autopilot already planned that day. Nothing changes; the existing quota check at handoff still applies.
   - `will_skip = true`: after the deploy, the autopilot plans no paid draft for that day. Decide per row: keep it (the scheduled post takes the day) or cancel the publication before the deploy.
   - `will_skip = false`, not planned: the autopilot plans the day as before.
4. Record in the rollout ledger below: the date, the row count, the `will_skip` count and the decision. Do not record the publication IDs or post texts here.

### Step 4 — window

From the context row: avoid two hours around every `posting_times` value (project timezone), the weekly plan moment (`plan_weekday_0_is_sunday`, `plan_time`), and any time when `open_publications` includes a post due within two hours. Prefer a weekday morning outside these times, with Mario available for Phase 1 checks.

### Phase 0 record

| Date       | Backup age  | Rollback target                 | Preview rows / `will_skip` | Decision                                                         | Window                       |
| ---------- | ----------- | ------------------------------- | -------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| 2026-10-03 | not checked | revert of the integration merge | not run                    | Approval B skipped by Mario (preview informational, see Phase 0) | to be chosen with Approval A |
