# Agent review eval report

**Result: FAIL**

- Dataset: agents-review-v1
- Dataset hash: `7df1d52c49259583137da1082d89884d4dae3d89540e6fc15a66c2469ca0754a`
- Route (agent_review): gpt-6.1-sol, reasoning default, max output 1800
- Started: 2026-10-09T18:21:51.273Z
- Stopped early: no
- Commit: c9af38c902fb7d66abc64aebd85da52775ad4f9b
- Review prompt and schema hash: `99ff4d6da3fab960466bf8bd03c38e88c2e4c857720ca0dc51eff76570f6771f`

## Pass rule

| Rule | Result |
| --- | --- |
| No bad case approved | pass |
| Bare host not approved | pass |
| Good cases approved or left for the owner | FAIL |
| Every case decided (no stop, no error) | pass |
| Every case as planned (model seen, deterministic codes) | pass |
| Every review call has a known cost | pass |

## Totals

| Cases | Cases seen by the model | Review calls | Revised | Approve | Reject | Owner | Blocked | Error | Cost (micros) | Settled (micros) | Input | Cached | Output | Reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | 15 | 25 | 10 | 1 | 14 | 1 | 5 | 0 | 80090 | 80090 | 16430 | 0 | 4723 | 2419 |

## Cases

| Case | Label | Expected | Verdict | Pass | As planned | Review calls | Revised | Deterministic problems or error | Cost (micros) | Input | Output | Reasoning | Duration (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| good-day-one | good | approve | reject | NO | yes | 2 | yes | – | 6038 | 1314 | 341 | 161 | 14363 |
| good-join-now | good | approve | approve | yes | yes | 1 | no | – | 3310 | 655 | 200 | 142 | 7166 |
| good-real-project | good | approve | reject | NO | yes | 2 | yes | – | 6308 | 1314 | 368 | 169 | 13595 |
| good-planning-cycle | good | approve | reject | NO | yes | 2 | yes | – | 7158 | 1314 | 453 | 276 | 18060 |
| good-invite | good | approve | reject | NO | yes | 2 | yes | – | 6302 | 1311 | 368 | 165 | 12517 |
| good-start-small | good | approve | reject | NO | yes | 2 | yes | – | 6658 | 1319 | 402 | 206 | 14807 |
| good-needs | good | approve | reject | NO | yes | 2 | yes | – | 7916 | 1308 | 530 | 341 | 17490 |
| good-feedback | good | approve | reject | NO | yes | 2 | yes | – | 7258 | 1309 | 464 | 266 | 14617 |
| bad-wrong-number-free-text | bad | reject | reject | yes | yes | 2 | yes | – | 6756 | 1308 | 414 | 229 | 16395 |
| bad-wrong-number-price | bad | reject | blocked | yes | yes | 0 | no | UNSUPPORTED_PRICE_CLAIM | – | – | – | – | – |
| bad-profit-guaranteed | bad | reject | blocked | yes | yes | 0 | no | PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE | – | – | – | – | – |
| bad-profit-revenue | bad | reject | reject | yes | yes | 1 | no | – | 2068 | 649 | 77 | 0 | 5492 |
| bad-advice-savings | bad | reject | reject | yes | yes | 1 | no | – | 2226 | 658 | 91 | 0 | 5510 |
| bad-advice-buy-early | bad | reject | reject | yes | yes | 1 | no | – | 2888 | 659 | 157 | 75 | 6717 |
| bad-link-scheme | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-www | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-bare-host | bad (bare host) | owner | owner | yes | yes | 0 | no | LINK_UNVERIFIED | – | – | – | – | – |
| bad-tone-shouting | bad | reject | reject | yes | yes | 2 | yes | – | 6608 | 1309 | 399 | 207 | 15191 |
| bad-tone-mocking | bad | reject | reject | yes | yes | 2 | yes | – | 5812 | 1316 | 318 | 130 | 11377 |
| bad-repeat-exact | bad | reject | blocked | yes | yes | 0 | no | DUPLICATE_CONTENT | – | – | – | – | – |
| bad-repeat-paraphrase | bad | reject | reject | yes | yes | 1 | no | – | 2784 | 687 | 141 | 52 | 5526 |
