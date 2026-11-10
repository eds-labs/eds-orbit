# Moving a project from Postiz to Social (runbook)

ADR 0020, programme plan §9 and §10 S10. One project at a time; **every step needs Mario's go**. Nothing here deletes or changes Postiz data; Postiz stays the live path until the switch in step 5.

The screen for all of it is **Social → Accounts → Move from Postiz** (owner). The same data is available at `GET /api/projects/:projectId/marketing/social-migration`; the inventory of every project is printed by `tsx scripts/postiz-inventory.ts [--project <id>]` inside the api container (read-only, counts only).

## Before the first project

- Production runs the code of S1–S10 with `ORBIT_SOCIAL=true` (schema hashes approved in Coolify), `ORBIT_SOCIAL_PLATFORMS` lists the platforms, the developer apps (Meta in Live mode, X) are set up (see [SOCIAL.md](SOCIAL.md)).
- Live posting: `EXECUTION_MODE=live`, `ENABLE_EXTERNAL_WRITES=true` (already the case for Marketing).

## Per project

1. **Accounts.** Enable the social module for the project. Connect every account Marketing posts to (X, Facebook Page, Instagram, Telegram channel; Telegram needs its own publishing bot). Write-verify each account with one approved real test post (Social → Accounts → "Verify posting"). *Evidence:* account list with `write_verified`.
2. **Mapping.** In "Move from Postiz" map every Postiz channel to its account (a suggestion is shown). The backend is switched per project, not per channel: a channel Social cannot post to yet (LinkedIn and other platforms) must be removed from Marketing's assigned channels before the switch, otherwise its posts would stop; the server refuses the switch while one is assigned. *Evidence:* the mapping table, `channels.mapped = channels.assigned`.
3. **Social on its own.** One post per platform with an image from Social (no Marketing), one scheduled, one canceled, one moved in the calendar; an MCP read and a draft proposal. *Evidence:* links of the posts, the canceled and moved ones in the calendar.
4. **History.** "Check history" (dry run) shows how many Postiz posts and drafts will be copied; "Copy history" writes them read-only into Social (origin `legacy_postiz`). Re-running is safe. *Evidence:* the counts.
5. **Drain.** "Stop new posts to Postiz" sets `publishingBackend: postiz_draining`: new publication intents, assignment draft bookings and owner draft handoffs are refused (`PUBLISHING_BACKEND_DRAINING`), what Postiz already has finishes and is reconciled. Keep this short: running assignments drop their deliverables while draining (pause them for the window if needed). Wait until the panel says "Postiz has nothing left to settle" (`readyToSwitch`; inventory `blockingSwitch = 0`), then run "Copy history" again so the posts that were in flight show their final state.
6. **Switch.** "Switch to Social" sets `publishingBackend: social`; the server refuses it (`PUBLISHING_BACKEND_NOT_READY`) while a channel is unmapped or not available in Social, or Postiz still has something unsettled. Marketing now hands posts to Social at their slot and creates assignment drafts in Social ([SOCIAL.md](SOCIAL.md#marketing-on-social-s9)). Posts approved before the switch fail their package check (`PACKAGE_CHANGED`) and need a new approval; nothing goes out by the old path.
7. **Watch.** The next three slots: each publication `published` with a Social link, the attention list empty (`SOCIAL_DELIVERY_BLOCKED`, `PUBLISH_OUTCOME_UNKNOWN`, `RECONCILIATION_POLL_LIMIT`). *Evidence:* recorded in `docs/IMPLEMENTATION_STATUS.md`.

## Readiness and the Postiz queue watch per backend

Marketing's readiness (the settings readiness card, Operations, the overview's action list, `project_readiness_get` and `marketing_project_status`) mirrors what preflight checks on the project's backend. Readiness returns `publishing: { backend, postizBacklog }`. `postizBacklog` is the inventory's `blockingSwitch`: publications and drafts Postiz holds unsettled.

| Backend | Readiness blockers | Actions |
| --- | --- | --- |
| `postiz` | As before: `PUBLISHER_WRITE_VERIFICATION_REQUIRED`, `CHANNEL_WRITE_VERIFICATION_REQUIRED` and the other Postiz codes. The output is unchanged and pinned by a test. | `publish_*` equal `postiz_*`. |
| `postiz_draining` | The Postiz checks stay, because Postiz still sends and reconciles what was approved before the drain. `PUBLISHING_BACKEND_DRAINING` is added; over MCP its `details.postizBacklog` gives the backlog. | `postiz_*` and `publish_*` are blocked by `PUBLISHING_BACKEND_DRAINING`, since new work is refused. |
| `social` | No Postiz code. Social's checks of the policy channels replace them: `SOCIAL_DISABLED`, `SOCIAL_CHANNEL_NOT_MAPPED`, `SOCIAL_ACCOUNT_NOT_ACTIVE`, `SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`, `SOCIAL_PLATFORM_NOT_AVAILABLE`, `SOCIAL_MEDIA_PUBLIC_REQUIRED`. `POLICY_CHANNELS_REQUIRED` applies when the policy has no channels. | `postiz_*` are `not_configured` (`PUBLISHING_BACKEND_SOCIAL`). `publish_draft` needs the module, an account behind each channel and `ENABLE_POSTIZ_DRAFTS`. `publish_schedule`/`publish_live` need Social's channel checks plus live mode, external writes and readable Drive images. |

The Social codes come from the same check preflight runs (`publishingBlockers`), run without a post. A platform that is switched off and Instagram without public media links are live-mode checks, as in preflight. An account whose posting was not verified counts in test mode as well, as the Postiz write verification always has. On Social, `marketing_project_status` also lists the connected accounts in `availableChannels` as `social:<accountId>`.

**Queue watch.** The read-only Postiz queue check (`postiz-queue`, feeds `/api/health/postiz`) keeps running for `postiz`, for `postiz_draining`, and for `social` while Postiz still holds a backlog. On `social` with no backlog it stops: it calls Postiz no more and the project has no next check time.

**Queue notices.** A stopped check never closed its own notices. That is how the "Orbit cannot read the Postiz queue" notice stayed open and kept counting. Open `POSTIZ_QUEUE_STALLED` and `POSTIZ_QUEUE_CHECK_FAILED` notices are now resolved when the watch stops on Social, and when the owner switches the project to Social. A resolved notice gets `status: resolved`, `resolvedBy`, `resolvedAt` and `resolution: publishing_backend_social`. Each notice writes an entity version and an audit event (`marketing.postiz_queue_notice_resolved` with code, count and reason). Nothing is deleted, other notices (`REMOTE_*` and so on) stay open, and a pass with nothing open writes nothing. After a rollback to Postiz the watch starts again and reopens nothing; a new failure opens a new notice.

## Rollback (any time after step 6)

"Back to Postiz" sets `publishingBackend: postiz`. Posts approved under Social fail their package check and need a new approval for Postiz; a post already handed to Social stays with Social (its publication keeps reading Social) and is never re-sent through Postiz. Assignments keep their channels (the Postiz integration ids); no change to policies or assignments is needed.

Before rolling the code back to a version without the draining mode (before S10), set every draining project back to `postiz`: older code does not know `postiz_draining` and cannot read the setting.

Rollback of the history mirror is a maintenance step: with the migration role, delete `SocialPublication` rows whose post has `origin = 'legacy_postiz'`, then those posts and their variants, for the project. Source data is untouched. Mirrored rows never count as attention items, are never settled or measured in Social, and keep Postiz's own post id in the provider state (not as a platform id).

## Decommissioning Postiz (after all projects switched and 30 days without a Social incident)

1. `ENABLE_POSTIZ_DRAFTS=false`; the Postiz connectors and connections disabled (not deleted). The queue watch has already stopped for each project on Social without a backlog. Note: the same switch also gates draft handoffs on Social (`publish_draft`), so turning it off stops those too.
2. Keep the Postiz code path for one release as rollback.
3. A separate, approved change removes the Postiz runtime code; the mirror and the inventory script stay.
4. Shutting the Postiz instance down is an infrastructure step outside this repository.

## Evidence template

```
Project: <name> (<id>)            Date: <YYYY-MM-DD>   Approved by: Mario
1 Accounts write-verified:        <platform: handle, …>
2 Channels mapped:                <n>/<n>  (left on Postiz: <…>)
3 Social-only checks:             <links>
4 History copied:                 <created>/<updated>/<unmapped>
5 Drained:                        started <time>, readyToSwitch at <time>
6 Switched:                       <time>
7 First three slots:              <publication ids, links>
Rollback rehearsed (test project): <date>
```
