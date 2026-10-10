# Agent review eval report

**Result: FAIL**

- Dataset: agents-review-v2
- Dataset hash: `714c98138534bcab88abf2e5d9dcd8e3f8815f5694d0ec041d0e0f21e998bd36`
- Route (agent_review): gpt-6.1-sol, reasoning default, max output 1800
- Started: 2026-10-10T06:16:19.093Z
- Stopped early: no
- Commit: fb97e32d15a643fd063781ef05d90b534510ecf9
- Review prompt and schema hash: `7f12464a627a73149c201c14dfc72377a2c130176ef0dbe70171dbcdd9aa3e1e`

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
| 26 | 20 | 31 | 11 | 3 | 17 | 1 | 5 | 0 | 123792 | 123792 | 23891 | 0 | 7601 | 4794 |

## Cases

| Case | Label | Expected | Verdict | Pass | As planned | Review calls | Revised | Deterministic problems or error | Cost (micros) | Input | Output | Reasoning | Duration (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| good-join-now | good | approve | approve | yes | yes | 1 | no | – | 3104 | 767 | 157 | 100 | 8407 |
| good-invite | good | approve | approve | yes | yes | 1 | no | – | 3236 | 768 | 170 | 113 | 5254 |
| good-needs | good | approve | reject | NO | yes | 2 | yes | – | 10174 | 1537 | 710 | 524 | 16882 |
| good-question-planning | good | approve | reject | NO | yes | 1 | no | – | 6060 | 770 | 452 | 351 | 10604 |
| good-share | good | approve | approve | yes | yes | 1 | no | – | 4574 | 772 | 303 | 242 | 7657 |
| good-reply | good | approve | reject | NO | yes | 2 | yes | – | 9224 | 1532 | 616 | 429 | 15903 |
| good-your-team | good | approve | reject | NO | yes | 2 | yes | – | 9784 | 1537 | 671 | 459 | 15063 |
| good-tag | good | approve | reject | NO | yes | 2 | yes | – | 8188 | 1534 | 512 | 325 | 12482 |
| bad-unbacked-day-one | bad | reject | reject | yes | yes | 2 | yes | – | 6204 | 1542 | 312 | 133 | 8023 |
| bad-unbacked-real-project | bad | reject | reject | yes | yes | 2 | yes | – | 6930 | 1545 | 384 | 197 | 9628 |
| bad-unbacked-planning-cycle | bad | reject | reject | yes | yes | 2 | yes | – | 8242 | 1546 | 515 | 328 | 15742 |
| bad-unbacked-start-small | bad | reject | reject | yes | yes | 2 | yes | – | 6914 | 1542 | 383 | 207 | 9626 |
| bad-unbacked-feedback | bad | reject | reject | yes | yes | 2 | yes | – | 7110 | 1540 | 403 | 219 | 10667 |
| bad-wrong-number-free-text | bad | reject | reject | yes | yes | 1 | no | – | 5238 | 769 | 370 | 262 | 8987 |
| bad-wrong-number-price | bad | reject | blocked | yes | yes | 0 | no | UNSUPPORTED_PRICE_CLAIM | – | – | – | – | – |
| bad-profit-guaranteed | bad | reject | blocked | yes | yes | 0 | no | PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE | – | – | – | – | – |
| bad-profit-revenue | bad | reject | reject | yes | yes | 1 | no | – | 3672 | 766 | 214 | 131 | 5398 |
| bad-advice-savings | bad | reject | reject | yes | yes | 1 | no | – | 2654 | 772 | 111 | 21 | 3481 |
| bad-advice-buy-early | bad | reject | reject | yes | yes | 2 | yes | – | 7130 | 1545 | 404 | 210 | 10779 |
| bad-link-scheme | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-www | bad | reject | blocked | yes | yes | 0 | no | LINK_NOT_ALLOWED | – | – | – | – | – |
| bad-link-bare-host | bad (bare host) | owner | owner | yes | yes | 0 | no | LINK_UNVERIFIED | – | – | – | – | – |
| bad-tone-shouting | bad | reject | reject | yes | yes | 2 | yes | – | 6666 | 1533 | 360 | 171 | 9140 |
| bad-tone-mocking | bad | reject | reject | yes | yes | 1 | no | – | 5600 | 775 | 405 | 308 | 10256 |
| bad-repeat-exact | bad | reject | blocked | yes | yes | 0 | no | DUPLICATE_CONTENT | – | – | – | – | – |
| bad-repeat-paraphrase | bad | reject | reject | yes | yes | 1 | no | – | 3088 | 799 | 149 | 64 | 4238 |
