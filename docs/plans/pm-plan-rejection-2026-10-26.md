# Incident: AI project manager plan refused (EOP, 2026-10-26)

Status: fix implemented locally on the branch `claude/pm-plan-rejection`; not pushed or deployed. No paid call was made for the analysis.

## What happened

An MCP client (ChatGPT) proposed a plan for the initiative EOP in the project EDS-Labs, and Mario approved it. The planning run failed 2.3 seconds after the request:

| Item | Value |
|---|---|
| Plan | `940341aa-14ea-4f6f-b38e-8ae8d384e49e`, status `failed`, `errorCode` `MODEL_REQUEST_NOT_ACCEPTED`, plan `null`, cost 0 |
| Run | `ca6c312d-8108-44dd-ab47-b47b8a8c954c` (`work.pm_planner`, task class `pm_plan`), status `failed` |
| Model call | one span `messages.create`, model `claude-opus-5-5`, status `failed`, 646 ms, no tokens, cost 0 |
| Route | `pm_plan` → `claude-opus-5-5`, `maxOutputTokens` 12,000, no effort. This was not a saved route: the project's default provider is Anthropic and the legacy tier of `pm_plan` is `quality`, which maps to Opus. The provider catalogue suggests `claude-sonnet-5-5` for `pm_plan`. |

## Cause, with evidence

1. **The provider refused the request; Orbit's budget did not.** `MODEL_REQUEST_NOT_ACCEPTED` is set in `runStructured` (`platform/agents/structured-run.ts`) only when a call has been reserved, transmitted and then refused by the provider with an unbilled HTTP status. For Anthropic these are 400, 401, 403, 404, 413, 422, 429 and 529 (`ANTHROPIC_UNBILLED_STATUSES`). Every Orbit check (spend mandate, route, project and PM budget) runs before the reservation, so all of them passed. A budget refusal would have ended the run as `blocked` with a budget code and without a model-call span.
2. **The key, the connection and `runStructured` work.** The same Anthropic key served successful calls of `claude-sonnet-5-5` in EDS-Labs, including structured finance extraction. Structured `runStructured` runs of `knowledge_evaluation` with Sonnet succeeded in FamilyPlan the same day.
3. **This call was the first of its kind:**
   - the first call of `claude-opus-5-5` in any project;
   - the only structured run that sends read tools *and* a JSON-schema output format together;
   - the largest output schema (plan with workstreams, milestones and tasks; 3.1 KB, 12 nullable unions, no optional fields, five patterns). It is within the documented limits of strict schemas, so it does not explain the refusal on its own evidence.
4. **The exact refusal reason was not recorded.** Unlike the chat (since 2026-10-24), `runStructured` stored only the generic code, not the provider's status, error type and message. The remaining candidates are:
   - a temporary refusal (529 overloaded or 429 rate limit, which for Opus is a separate per-model limit);
   - a model the key may not use (404);
   - a request field refused for this model (400).

   The stored data cannot tell these apart. **This gap is the defect that kept the cause unproven, and it is fixed.**
5. **A failed plan could not be planned again.** `requestPlan` maps a repeated request with the same idempotency key, which an MCP client always sends for the same arguments, to the existing proposal. It returned the failed proposal unchanged. Revisions were allowed only for draft, proposed or invalid plans.

## Changes

| Component | Change |
|---|---|
| `packages/ai/src/rejection.ts` | `rejectionCode`: `MODEL_RATE_LIMITED` (429), `MODEL_OVERLOADED` (529), `MODEL_AUTH_REJECTED` (401, 403), `MODEL_NOT_AVAILABLE` (404), `MODEL_REQUEST_INVALID` (400, 413, 422); `TEMPORARY_REJECTIONS`. |
| `platform/agents/structured-run.ts` | A refused call ends with the specific code. Its span records the provider's status, error type and the start of its message (plain characters, no prompt text) and the provider's request id. The cost stays 0 and the reservation is released at 0. This affects every structured run: PM planning, reports and analyses, issue triage and knowledge test questions. The chat is unchanged. |
| `modules/work/pm/planner.ts`, `routes.ts` | `retryPlan` and `POST /work/pm/plans/:id/retry` (`work.pm.use`). A failed plan is planned again as a new revision with the same request text. The failed revision is superseded and hands over its idempotency key, so a repeated retry or the same request again finds the running revision instead of starting a second one. Spend mandate and PM budget are checked first. The same request after a failure (for example from MCP, after a new approval) also plans again. |
| Web (`work/pm.tsx`, `pm-labels.ts`) | A failed plan shows the reason in words (en/de), the code, and "Plan again" for members who may ask the PM. |

Unchanged:
- approvals: an MCP plan request still needs its approval, and a plan still needs a second approval before tasks are created;
- the rule that an unclear call is never resent;
- budgets and the route selection.

## Tests

`apps/api/tests/work-pm-plan-failures.integration.test.ts` (scripted model, SDK error types):
- Refusals 529, 429, 400, 404 and 401 each give their own code, no plan, no task, no request, cost 0 and a reservation settled at 0. The span holds the provider's status, type and request id.
- A retry after a failure creates a new revision. The same request again starts it once and then deduplicates. The failed revision cannot be retried twice. The retry succeeds and waits for approval, and a replayed job runs nothing.
- An invalid answer (`AGENT_OUTPUT_INVALID`) never becomes a plan; a viewer cannot retry; there is no retry without budget; a requester who left fails the run before any model call.

Further tests:
- `packages/ai/src/rejection.test.ts`: the codes for OpenAI and Anthropic, including 529 and the request id.
- `apps/web/src/modules/work/pm.test.tsx`: the failure texts.
- The existing planning tests (success, approval, apply once, budget, unclear outcome) are unchanged and green.

## Recommended production configuration

- Save an explicit route for **`pm_plan` = `claude-sonnet-5-5`** in Settings → AI ("Project manager plans"), with 12,000 output tokens. This is what the catalogue suggests and the model proven with this key. Opus 5.5 stays possible, but only after one approved test plan has shown it works with this key.
- Keep `pm_analysis` on Sonnet (already effective) and the PM budget at USD 2 per day. A Sonnet plan costs at most about USD 0.2 per call, so the USD 1 per-run ceiling holds.

## Rerunning the failed EOP plan (after the fix is deployed)

1. Optional, recommended: set the `pm_plan` route to Sonnet as above.
2. Open Projektmanagement → Vorhaben EOP → the failed plan and click **Erneut planen**. Alternatively, ask ChatGPT to propose the same plan again and approve the new request in Orbit's decisions.
3. The new revision runs once. If the provider refuses again, the plan shows the reason in words, and the run's model-call span holds the provider's status and message. This answers the open question at no cost, because a refused call is not billed.
4. A proposed plan needs the second approval before any task is created.

## Controlled end-to-end test (prepared, not run)

It needs Mario's approval: one paid planning call of at most USD 1 within the PM budget.
1. Deploy the fix.
2. In EDS-Labs, set the `pm_plan` route (Sonnet).
3. Retry plan `940341aa…` as above.
4. Check: the plan is `proposed` with a cost under USD 1; its approval appears in the decisions; the AgentRun has one `messages.create` span with tokens; nothing is created before approval.
5. Approve or reject the plan.
