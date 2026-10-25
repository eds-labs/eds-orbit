# n8n coding agent workflow (outline)

The contract is in [`docs/integrations/coding-agent.md`](../../../docs/integrations/coding-agent.md). This folder holds no workflow export yet: the workflow, its GitHub rights and the coding system it starts need Mario's separate approval before anything is built or connected (Q-P2-4).

Outline of the workflow, once approved:

1. **Webhook** (`POST`, path = the binding's `workflowRef`), raw body kept.
2. **Verify**: HMAC-SHA256 of `timestamp + "." + body` with the connection's signing secret, constant-time compare, timestamp within ±5 minutes; otherwise answer 401 and stop.
3. **Route by `event`**: `coding_agent.requested` starts the agent; `coding_agent.cancel_requested` stops the run for `codingRunId`.
4. **Start the agent** in exactly `payload.repository` against `payload.baseBranch` (for example `workflow_dispatch` of a repository workflow running Claude Code with `briefMarkdown` as the prompt), with its own budget limit from `ceilingMicros`.
5. **Callback** `running` + `result.status: "started"` once the agent runs; at the end `completed` (or `failed`) with branch, pull request URL, commit, test counts and the reported cost.
6. Never merge, deploy or touch other repositories; never send secrets or customer data back.
