# Operator evals (Orbit Core)

Fixed cases for the one visible operator (Orbit Core plan, sections 11 and 16). Each case replays recorded model steps through the real chat runner, tool registry, package services, budget journal and database; only the model is scripted. The checks look at what the server did: run status, offered tools, error codes returned to the model, packages, missions and publications created.

- `cases-v1.json`: the dataset. Each case records input, expected and forbidden behaviour, allowed tools, risk and machine checks, following `.agentic/ai/evals.md`.
- `harness.ts`: schema, dataset hash, date placeholders and the recorded Responses stream events.
- `offline.test.ts`: runs every case in `pnpm test` against the isolated local test database. No network call and no paid call; the test title shows the dataset hash.

`cases-v1.json`: JC01 primary package request, JC02 profile defaults, JC03 unusable fact, JC05 next week, JC11 injected source text, JC13 viewer, JC20 feature off.

`cases-v2.json` (J3 scheduling): JC16 an owner's schedule proposal waits for the decision, JC15 a day the autopilot covers is refused with the next free slot, JC13 a viewer cannot schedule. A v2 case may set `fixture` (`started_package`: a started X package with a reviewed draft in the case's conversation; `autopilot_day`: additionally the last free X day planned by the autopilot, available as `{{autopilotDay}}`) and the checks `scheduleRequests` and `toolOutputIncludes`. Every case runs in a fresh project.

What this does not show: how a real model chooses these steps. A live operator run needs a separately approved paid acceptance run; record its result next to the dataset hash it used.

Changing a case changes the dataset hash. Add new cases as `cases-v2.json` instead of editing recorded ones, so earlier results stay comparable.
