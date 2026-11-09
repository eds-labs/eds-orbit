# Knowledge: one row per source, grouped knowledge and plain language

Date: 2026-11-09. Status: design approved in chat by Mario (decisions D-1 to D-8 below); spec awaiting review. Package 3 of the Knowledge review of 2026-11-08. Builds on packages 1 and 2, live at `80cb5cd8`.

## Goal

An owner opens Knowledge and sees at once what exists, what needs them and what to do next, without technical terms. The model on every page is **source, then proposals, then knowledge**.

## Findings this design rests on

- The Sources page renders two different row kinds from `workspace.tsx`: `knowledge_drafts` (`SourceList`) and directly managed `sources` (`ManagedSource`). They differ in layout and actions. A managed row can show up to seven controls.
- Proposals already carry one of five topics (`description`, `audience`, `platforms`, `features`, `limitations`), used only by a filter select.
- Every review card shows a statement textarea and three rights checkboxes. Evidence is folded. Decisions go one at a time through `knowledge-proposal-decide`, which takes `publicUse` and at least one audience.
- The draft holds the rights chosen on the Use step (`input.rights`); the review card starts from them. Older drafts have none, and the card then starts with Marketing and Support on and public off.
- GitHub reads re-check the signed-in owner's access. User tokens are not stored, so Orbit cannot read a repository in the background without changing that rule.
- Website and GitBook sources have read themselves weekly since package 2. Text and uploaded documents have nothing to re-read.
- The technical view is reached through a fold named "Advanced" and `?expert=1`. `knowledge.tsx` still contains hard-coded English labels, and the health page prints keys as headings (`key.replace(/([A-Z])/g, " $1")`).
- `/knowledge-health` returns `missingEvidence` and `impacts` from the same filter, so the same content records appear on two pages under two names.

## Decisions

| ID | Decision |
| --- | --- |
| D-1 | Web only. No API change, no new action, no migration, no new dependency, no change to the access matrix. |
| D-2 | One row model for every source: name, kind, one status, one sentence, last read, at most one primary action. Everything else moves to "More". |
| D-3 | GitHub sources and single-page website drafts get a reminder in their row 30 days after the last successful read. No background check, no attention item. |
| D-4 | Knowledge and To review are grouped by the five existing topics. The topic select goes away. |
| D-5 | Bulk confirm uses each statement's effective rights: the source's Use step defaults unless the owner changed them on that card. The bar has no switches of its own. |
| D-6 | Changed statements (`needs_review`) are never part of a bulk confirm. Bulk reject does not exist. |
| D-7 | The terms are source, proposal and knowledge; "statement" is the countable word for one piece of knowledge. Fact, index and generation appear only in the technical area. |
| D-8 | "Advanced" becomes one link to a technical area with its own navigation. Only language and navigation change there; all existing URLs keep working. |

## Sources page

`sourceRows` (new pure function) turns the workspace payload, the index status and the current time into one row per visible draft and listed source: id, name, kind label, status, tone, sentence, last read, primary action, more actions. The page renders only rows. Rows with statuses 3 to 7 need the owner and sort first, in that order, then the others; within a status, by name.

The first matching status wins:

| # | Status | Applies when | Primary action |
| --- | --- | --- | --- |
| 1 | Reading | analysis or site run active | none; progress shown |
| 2 | Paused | source paused; a paused source raises no other state | Resume |
| 3 | Failed, with reason | latest analysis `failed` or `unknown`; latest site run `failed` except `SOURCE_INACTIVE` and `KNOWLEDGE_DISABLED` | Try again |
| 4 | n proposals waiting | draft with `pending` or `needs_review` proposals | Review |
| 5 | Never read (source) or Not finished (draft) | source without a successful read; draft without a completed analysis | Read in content (source), Continue setup (draft) |
| 6 | Out of date | source whose freshness state is `stale` | Update |
| 7 | Not read for a while | GitHub or website draft, last successful read 30 or more days ago | Update |
| 8 | Up to date | everything else; manually maintained content keeps its "maintained by hand" label | none |

The existing `expiring` freshness state stays visible as the sentence on status 8 with warning tone. It does not add a status.

Primary actions reuse what exists:

- Try again on a site runs `knowledge-site-refresh`. On a draft it opens the draft in the add flow.
- Review opens To review. Each card names its source, so no filter is added.
- Read in content opens `knowledge/import?site=<id>` for a website or GitBook source and the expert page for any other source, as today.
- Update on a site runs `knowledge-site-refresh`. On a draft it opens the existing confirmation before `knowledge-draft-preview`. On a source without a site reader it links to the expert page.
- Text and uploaded documents have no Update. They can be edited.

"More" holds: Edit or Manage, Pause, Weekly updates (site sources), History (drafts), Library, Remove. Each appears under the conditions it has today. Readers without owner rights see status and sentence only, no actions. The menu follows the existing pattern in `apps/web/src/platform/shell/user-menu.tsx`.

`?source=<id>` keeps focusing the matching row, so warning links still land on it. A draft row gets the same anchor.

Two entries with the same address stay two rows. Both can carry confirmed knowledge, so merging them is out of scope.

## Knowledge and To review

Both pages list statements under topic headings in the order above, each with its count. Empty topics are hidden. Older verified facts without a topic go under "Other". Search stays and filters inside the groups.

**Review card.** It shows the statement as text, its source name, the evidence quote with its location and link, the reason, and one line with its rights (for example "Marketing and Support · internal"). Buttons: Confirm, Reject, Adjust. Adjust opens today's form (statement text and the three rights). Stage hint, commit and history move under "More about the evidence".

**Changed statements** come first in their own group, with no checkbox, and keep Keep using and Remove.

**Bulk confirm** (owners only):

- Each selectable card has a checkbox, and each topic heading has "Select all" for its selectable cards.
- A card without any audience cannot be selected and says why. It can still be adjusted.
- Selecting anything shows a bar that stays in view: for example "12 statements · Marketing and Support · 5 public", and the button "Confirm selection". Mixed audiences read "Marketing 8 · Support 11".
- If any selected statement is not public while Marketing or Support is on, the bar repeats the existing note that customers only see public knowledge.
- Effective values are the owner's edits on the card, else the draft's rights, else Marketing and Support on and public off. Card edits and the selection live above the cards, so polling or a re-render does not lose them, and ids no longer listed are dropped from the selection.
- Confirming sends `knowledge-proposal-decide` for one statement after another with its current version. A failure does not stop the rest.
- The result reads "10 of 12 confirmed". Failed cards stay selected and show their reason through the existing `WorkspaceError` (for example `VERSION_CONFLICT`, `KNOWLEDGE_EVIDENCE_CHANGED`). The list refreshes once at the end.
- The button is disabled while a confirm runs. Leaving the page stops the remainder: what was confirmed stays, the rest stays pending.
- No model call is involved.

## Language and the technical area

Every Knowledge page has one sentence stating where it sits in source, proposals, knowledge. All user-facing copy in the workspace uses the terms of D-7, in German and English.

The fold "Advanced" is replaced by one quiet link "Technical area" that opens `knowledge/health?expert=1`.

A new `TechnicalNav` sits above the expert pages when the Knowledge workspace is enabled: Sources, Facts, Conflicts, Import, Library, Status, Search check, Affected content, a link to GitHub App settings for owners, and a link back to Knowledge. With the workspace flag off the legacy sidebar stays and the bar is not shown. `TAB_NAV`, routes, `legacyPaths` and `?expert=1` do not change.

In `knowledge.tsx`:

- All hard-coded labels go through the existing translations, in German and English.
- Health headings and counters use named labels instead of the transformed key.
- Raw values such as `verified_facts` are shown with labels; an unknown value falls back to a generic label, never the raw value.
- A raw id is shown only where no name exists, in a secondary line.
- The health page drops `missingEvidence`. The same records stay on the Impact page, titled "Affected content". The API keeps both keys.

## Code structure

- `apps/web/src/modules/knowledge/source-rows.ts`: the pure row model.
- `apps/web/src/modules/knowledge/source-list.tsx`: the rows, moved out of `workspace.tsx`, which is at 1,073 lines and would otherwise grow.
- `apps/web/src/modules/knowledge/statements.tsx`: grouping, cards and bulk selection.
- `apps/web/src/modules/knowledge/technical-nav.tsx`: the bar.
- Copy in `workspace-text.ts` and the translations `knowledge.tsx` already uses.

`apps/web` must not import server code. The boundaries in `scripts/boundaries.json` are unaffected.

## Testing

- `sourceRows`: each status row of the table, the priority between overlapping states, the 30-day boundary, the exclusions of `SOURCE_INACTIVE` and `KNOWLEDGE_DISABLED`, no Update for text and documents, sort order, no actions for a reader.
- Grouping: topic order, empty topics hidden, "Other", search inside groups.
- Bulk: effective rights from the draft, from a card edit and for an old draft without rights; audience-less card not selectable; changed statements not selectable; the sentence in the bar for uniform and mixed rights; partial failure leaves failed cards selected with their reason; selection survives a refresh; one refresh at the end.
- Technical area: the bar appears only with the workspace on, every existing expert URL still renders, no raw key text on the health page, both languages.
- `apps/web/tests/knowledge-workspace.spec.ts` updated for the new rows and bulk confirm at 1440 px and 390 px.
- Standard checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the design detector on `apps/web/src/modules/knowledge`.

## Risk and rollback

Risk medium: no data or permission change, but the main owner flow for confirming knowledge changes, and bulk confirm can put many statements into use with one click. The bar shows the effect before the click, and every statement can still be removed and restored individually.

Rollback is a revert. Nothing is stored in a new shape. Delivery to `main` deploys and needs Mario's approval. No schema hash is needed.

## Out of scope

Merging entries with the same address; converting old single-page website drafts to site sources; redesigning the content of the technical pages; a commit check for GitHub; bulk reject; rechecking confirmed statements when a site page changes (parked in package 2).
