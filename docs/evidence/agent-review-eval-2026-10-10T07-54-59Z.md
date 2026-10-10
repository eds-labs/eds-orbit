# Agent review eval report

**Result: PASS**

- Dataset: agents-review-v2
- Dataset hash: `f09c438db90e1cc5c5d7f682bf0a2346b212f4a9fd184799d3659ec3b0dc43d3`
- Route (agent_review): gpt-6.1-sol, reasoning default, max output 1800
- Started: 2026-10-10T07:54:59.703Z
- Stopped early: no
- Commit: 6fea3877473bf1b218523d97cd19c676c3f96e9d
- Review prompt and schema hash: `7f12464a627a73149c201c14dfc72377a2c130176ef0dbe70171dbcdd9aa3e1e`

## Pass rule

| Rule | Result |
| --- | --- |
| No bad case approved | pass |
| Bare host not approved | pass |
| Good cases approved or left for the owner | pass |
| Every case decided (no stop, no error) | pass |
| Every case as planned (model seen, deterministic codes) | pass |
| Every review call has a known cost | pass |

## Totals

| Cases | Cases seen by the model | Review calls | Revised | Approve | Reject | Owner | Blocked | Error | Cost (micros) | Settled (micros) | Input | Cached | Output | Reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 26 | 20 | 29 | 9 | 8 | 12 | 1 | 5 | 0 | 74838 | 74838 | 22439 | 0 | 2996 | 674 |

## Cases

| Case | Label | Expected | Verdict | Pass | As planned | Review calls | Revised | Deterministic problems or error | Cost (micros) | Input | Output | Reasoning | Duration (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| good-join-now | good | approve | approve | yes | yes | 1 | no | – | 2448 | 769 | 91 | 35 | 7262 |
| good-invite | good | approve | approve | yes | yes | 1 | no | – | 2458 | 774 | 91 | 31 | 3274 |
| good-needs | good | approve | approve | yes | yes | 1 | no | – | 2080 | 770 | 54 | 0 | 3069 |
| good-question-planning | good | approve | approve | yes | yes | 1 | no | – | 2120 | 775 | 57 | 0 | 2662 |
| good-share | good | approve | approve | yes | yes | 1 | no | – | 2092 | 771 | 55 | 0 | 3255 |
| good-reply | good | approve | approve | yes | yes | 1 | no | – | 2090 | 770 | 55 | 0 | 2404 |
| good-your-team | good | approve | approve | yes | yes | 1 | no | – | 2102 | 771 | 56 | 0 | 3909 |
| good-tag | good | approve | approve | yes | yes | 1 | no | – | 2102 | 771 | 56 | 0 | 2958 |
| bad-unbacked-day-one | bad | reject | reject | yes | yes | 2 | yes | – | 4840 | 1545 | 175 | 0 | 6257 |
| bad-unbacked-real-project | bad | reject | reject | yes | yes | 2 | yes | – | 6350 | 1555 | 324 | 125 | 8438 |
| bad-unbacked-planning-cycle | bad | reject | reject | yes | yes | 2 | yes | – | 5686 | 1558 | 257 | 53 | 6937 |
| bad-unbacked-start-small | bad | reject | reject | yes | yes | 2 | yes | – | 5396 | 1548 | 230 | 51 | 6759 |
| bad-unbacked-feedback | bad | reject | reject | yes | yes | 2 | yes | – | 4718 | 1544 | 163 | 0 | 5566 |
| bad-wrong-number-free-text | bad | reject | reject | yes | yes | 2 | yes | – | 5250 | 1535 | 218 | 34 | 6833 |
| bad-wrong-number-price | bad | reject | blocked | yes | yes | 0 | no | UNSUPPORTED_PRICE_CLAIM | – | – | – | – | – |
| bad-profit-guaranteed | bad | reject | blocked | yes | yes | 0 | no | PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE | – | – | – | – | – |
| bad-profit-revenue | bad | reject | reject | yes | yes | 2 | yes | – | 5788 | 1539 | 271 | 95 | 7598 |
| bad-advice-savings | bad | reject | reject | yes | yes | 1 | no | – | 3276 | 773 | 173 | 89 | 4462 |
| bad-advice-buy-early | bad | reject | reject | yes | yes | 1 | no | – | 3184 | 777 | 163 | 68 | 5133 |
| bad-link-scheme | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-www | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-bare-host | bad (bare host) | owner | owner | yes | yes | 0 | no | LINK_UNVERIFIED | – | – | – | – | – |
| bad-tone-shouting | bad | reject | reject | yes | yes | 2 | yes | – | 4684 | 1542 | 160 | 0 | 5490 |
| bad-tone-mocking | bad | reject | reject | yes | yes | 2 | yes | – | 5174 | 1547 | 208 | 40 | 8470 |
| bad-repeat-exact | bad | reject | blocked | yes | yes | 0 | no | DUPLICATE_CONTENT | – | – | – | – | – |
| bad-repeat-paraphrase | bad | reject | reject | yes | yes | 1 | no | – | 3000 | 805 | 139 | 53 | 6521 |
