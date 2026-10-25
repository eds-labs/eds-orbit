# Coding agent workflow (ADR 0017, WP2.9)

Orbit never runs code. A coding work order of the AI project manager is dispatched, after the owner's approval, to a workflow of a central n8n connection (ADR 0014). The workflow starts the coding system (for example a Claude Code GitHub Action or a Codex cloud task) and reports back through Orbit's signed automation callback. This page is the contract between Orbit and that workflow.

**State:** implemented and tested against a fake endpoint only. No live dispatch exists. A live setup needs Mario's separate approval of the workflow, the repository and the GitHub rights the workflow holds (Q-P2-4).

## Setup in Orbit

1. An organization owner creates the n8n connection and binds the workflow with contract `automation.v1` (Settings → Administration → Connections), then grants the connection to the project with purpose `automation`.
2. The project owner adds the repository under Projektmanagement → KI-Projektleiter: key, `owner/name`, base branch, dispatch `automation` with the binding, a monthly coding budget (`codingMonthlyCeilingMicros`; 0 blocks every paid dispatch), the number of concurrent runs and the timeout in hours.

## Request (Orbit → workflow)

`POST <n8n>/webhook/<workflowRef>` with the headers `X-Orbit-Timestamp`, `X-Orbit-Request-Id` and `X-Orbit-Signature: v1=<HMAC-SHA256(signingSecret, timestamp + "." + body)>`, and this body:

```json
{
  "contract": "automation.v1",
  "requestId": "…",
  "runId": "<automation run id>",
  "event": "coding_agent.requested",
  "callbackUrl": "https://<orbit>/api/automation/callbacks/<projectId>/<runId>",
  "payload": {
    "codingRunId": "…",
    "repository": "owner/name",
    "baseBranch": "main",
    "task": { "number": 12, "title": "…" },
    "brief": {
      "goal": "…", "description": "…",
      "acceptanceCriteria": ["…"], "constraints": ["…"], "doNotTouch": ["…"],
      "testExpectations": "…"
    },
    "briefMarkdown": "…",
    "ceilingMicros": 1000000,
    "timeoutHours": 24
  }
}
```

The brief is redacted before it leaves Orbit: e-mail addresses, phone numbers, credentials and keys, wallet addresses and transaction hashes are replaced. A person also confirms that it holds no personal data. The workflow must verify the signature and the timestamp (±5 minutes). It must only work in `repository`, open a pull request against `baseBranch`, and never merge or deploy.

To cancel, Orbit sends `event: "coding_agent.cancel_requested"` with `{ codingRunId, automationRunId }`. The workflow stops the agent and reports `canceled` on the original run.

## Callback (workflow → Orbit)

`POST callbackUrl`, signed with the same secret (`X-Orbit-Timestamp`, `X-Orbit-Signature`). Every field of the body is checked strictly; an unknown field is refused with 400.

```json
{ "status": "running", "executionId": "…", "result": { "status": "started", "branch": "agent/fees" } }
{ "status": "completed", "result": {
    "status": "succeeded",
    "branch": "agent/fees",
    "prUrl": "https://github.com/owner/name/pull/77",
    "commitSha": "abc1234",
    "tests": { "passed": 12, "failed": 0, "skipped": 0, "summaryUrl": "https://…" },
    "reportedCostMicros": 1500000,
    "summary": "≤ 2000 characters, shown as untrusted text"
} }
{ "status": "failed", "errorCode": "AGENT_TIMEOUT", "result": { "status": "failed", "errorCode": "AGENT_TIMEOUT" } }
```

- `result.status`: `started`, `succeeded`, `failed` or `canceled`. The callback's own `status` is `running` while the run is going, `completed` or `failed` at the end.
- `prUrl` must be a pull request of the configured repository, otherwise the callback is refused.
- After the final callback, replays change nothing. A report older than the recorded state (out of order) is ignored.
- A run without a callback for `timeoutHours` becomes `outcome_unknown` and shows as attention. Orbit never resends a dispatch.

## What changes in Orbit

`started` moves the task to *in progress*. `succeeded` moves it to *in review* and records the branch, pull request, commit and test numbers. A person marks the task done; a merged pull request does not. Reported costs count towards the project's monthly coding budget.
