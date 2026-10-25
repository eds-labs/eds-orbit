# AI project manager eval (WP2.11)

Measures the planner (`pm_plan`, ADR 0017) on six synthetic goals, including the marketplace launch and a goal with a prompt injection. Only structure is scored, never plan text:

- every answer valid against the production schema;
- no dependency cycles;
- no assignee outside the members list;
- acceptance criteria on at least 90 % of tasks;
- at least 80 % of tasks in a milestone;
- 15 to 60 tasks per plan on average.

The thresholds are in `metrics.ts`. Passing them is a condition for switching `ORBIT_WORK_PM` on (plan §12, DoD 10).

- `metrics.test.ts` runs in the normal suite and calls no model.
- `pnpm eval:work-pm` prints the plan: goals, route, worst-case cost and the confirmation string. Without confirmation it transmits nothing.
- A live run needs Mario's approval of its budget (proposal: at most USD 2; `ORBIT_EVAL_MAX_USD` can only lower it), a key (`ORBIT_EVAL_OPENAI_API_KEY` or the keychain service of `evals/agents/eval-key.ts`) and `ORBIT_EVAL_CONFIRM=<printed confirmation>`. It sends the production instructions and schema, one call per goal, with no tools. It stops before a call could pass the ceiling and writes ids, counts and costs to `docs/evidence/work-pm-eval-<time>.json`.
- The rate card of `evals/generation/candidates-v1.json` (verified 2026-09-30) is valid for 31 days. A live run after 2026-10-31 needs prices verified again.
