# Operator evals (Orbit Core)

Fixed cases for the one visible operator (Orbit Core plan, sections 11 and 16). Each case replays recorded model steps through the real chat runner, tool registry, package services, budget journal and database; only the model is scripted. The checks look at what the server did: run status, offered tools, error codes returned to the model, packages, missions and publications created.

- `cases-v1.json`: the dataset. Each case records input, expected and forbidden behaviour, allowed tools, risk and machine checks, following `.agentic/ai/evals.md`.
- `harness.ts`: schema, dataset hash, date placeholders and the recorded Responses stream events.
- `offline.test.ts`: runs every case in `pnpm test` against the isolated local test database. No network call and no paid call; the test title shows the dataset hash.

Cases: JC01 primary package request, JC02 profile defaults, JC03 unusable fact, JC05 next week, JC11 injected source text, JC13 viewer, JC20 feature off.

What this does not show: how a real model chooses these steps. A live operator run needs a separately approved paid acceptance run; record its result next to the dataset hash it used.

Changing a case changes the dataset hash. Add new cases as `cases-v2.json` instead of editing recorded ones, so earlier results stay comparable.
