# Autonomy policy

Implemented local RC contract, 2026-09-17. The server is authoritative; a prompt, browser control, or imported document cannot grant permissions.

## Mandates and execution

A new project starts in Observe and an empty knowledge state. Owner-created policy versions bind channels, content types, allowed link origins, an explicit validity window, daily frequency, channel spacing, quiet hours, and USD-micro budgets. Assisted mode requires one unexpired approval of the exact content/evidence/asset/link/schedule/policy/connector package. Autopilot requires a current owner policy and verified runtime capabilities. Live mission publishing additionally requires that mission's explicit `publish_live` action. Editors cannot activate policies or administer credentials.

Test execution never contacts publishing providers. It produces `published_test` receipts with synthetic content labels. Live publishing requires the external-write environment gate, current evidence and claims, a passed current live index evaluation with bound paid receipts, account-specific Postiz proof for this publisher instance, and separate PNG proof when media is present. Connector credentials alone grant no capability. Mail, advertising, public community replies and an unspecified blog target have no live executor; their drafts/imports/exports remain usable.

The publication package is checked at intent creation, queue claim and immediately before the provider handoff. Saved future dates cannot be bypassed by omitting the date in an action. Manual calendar blocks are checked at planning and handoff, and block pending local intents. Project and workspace-wide pause fence current projects and expose pending remote actions for reconciliation. New projects still start in Observe. Already accepted external writes cannot be promised retractable.

## Bounded planning

Each successful generation or deliberate reuse consumes one of the original mission's `maxContents` work packages. Follow-up timing is derived from the approved window and count; it cannot extend the window, audience, budget or channel set. A follow-up waits for the prior result or explicit disposition, reads only current campaign insights and confirmed editorial preferences, and records their versions. Reused content does not create another publication. An observed explicitly configured metric target can end work early; uncertainty never increases authority.

Jobs have durable IDs, at most three attempts, a two-minute lease, bounded queue concurrency and backoff. Paid calls have their own durable transmission claim; an existing reservation is never sent again. Query embedding and text generation share a work-package limit. Reindex batches share an index-build limit, and evaluation batches share an evaluation limit. Daily/monthly limits use UTC accounting boundaries; publication slots use the project timezone. Unknown provider costs retain the reserved amount. A model cannot adjust these limits.

## Exceptions and recovery

Exceptions are grouped by project and cause. A paused, expired, revoked, stale, unknown or unsupported action requires a new valid condition; retries do not override the condition. Ambiguous publication remains `outcome_unknown`, never blindly resent. Known remote IDs receive at most eight bounded read polls; unresolved state becomes an owner exception. Postiz group deletion is not exposed because its current API cannot prove the current group membership. Manual provider review is required.

Slack messages are separately authorized by an expiring owner mandate, exact team/channel, mapped current owners and signing secret. Actions bind a versioned one-use resource preview. HMAC, timestamp, replay and stale-package checks apply. Message uncertainty does not trigger resend. The web UI remains the independent approval path.

Infrastructure administration, SSH, Docker, DNS, payments, training and cloud control are absent from the runtime agent tools. Deployment and production activation remain separate operator actions.
