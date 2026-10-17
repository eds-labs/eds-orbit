# Operator evals (Orbit Core)

Fixed cases for the one visible operator (Orbit Core plan, sections 11 and 16). Each case replays recorded model steps through the real chat runner, tool registry, package services, budget journal and database; only the model is scripted. The checks look at what the server did: run status, offered tools, error codes returned to the model, packages, missions and publications created.

- `cases-v1.json`: the dataset. Each case records input, expected and forbidden behaviour, allowed tools, risk and machine checks, following `.agentic/ai/evals.md`.
- `harness.ts`: schema, dataset hash, date placeholders and the recorded Responses stream events.
- `offline.test.ts`: runs every case in `pnpm test` against the isolated local test database. No network call and no paid call; the test title shows the dataset hash.

`cases-v1.json`: JC01 primary package request, JC02 profile defaults, JC03 unusable fact, JC05 next week, JC11 injected source text, JC13 viewer, JC20 feature off.

`cases-v2.json` (J3 scheduling): JC16 an owner's schedule proposal waits for the decision, JC15 a day the autopilot covers is refused with the next free slot, JC13 a viewer cannot schedule. A v2 case may set `fixture` (`started_package`: a started X package with a reviewed draft in the case's conversation; `autopilot_day`: additionally the last free X day planned by the autopilot, available as `{{autopilotDay}}`) and the checks `scheduleRequests` and `toolOutputIncludes`. Every case runs in a fresh project.

`cases-v3.json` (Phase 4, WP4.4: across modules) runs in `cross-module.test.ts` with the test-only fixture module `tasks` registered, so v1 and v2 keep their tool sets. It contains:
- JC30: knowledge, marketing and fixture tools in one run, with two proposals as two ActionRequests.
- JC31: a viewer gets no module write, and a forged call is refused.
- JC32: a switched-off module offers nothing.
- JC33: with every module off, the platform's `knowledge_search` still works.

A v3 case may set `disabledModules` (switched off in this order) and the check `actionRequests` (requests created by action type).

What this does not show: how a real model chooses these steps. A live operator run needs a separately approved paid acceptance run; record its result next to the dataset hash it used.

Changing a case changes the dataset hash. Add new cases as `cases-v2.json` instead of editing recorded ones, so earlier results stay comparable.
