# Knowledge structure and language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One uniform row per source, knowledge grouped by topic with bulk confirm, and a German and English technical area.

**Architecture:** Web only. Pure model functions (`source-rows.ts`, `statements-model.ts`) hold every decision and are unit tested; thin components render them. Bulk confirm calls the existing `knowledge-proposal-decide` once per statement.

**Tech Stack:** TypeScript, React, Next.js (read `apps/web/AGENTS.md` first), vitest with `renderToStaticMarkup` (no DOM testing library in this repo), Playwright for interaction.

**Spec:** `docs/superpowers/specs/2026-11-09-knowledge-structure-and-language-design.md`

## Global Constraints

- Web only: no API change, no new action, no migration, no new dependency, no change to `apps/api/tests/fixtures/access-matrix.json`.
- Existing URLs, `?expert=1`, `?source=<id>`, `TAB_NAV`, routes and `legacyPaths` keep working.
- All user-facing text in German and English. Code comments in English.
- Terms: source (Quelle), proposal (Vorschlag), knowledge (Wissen), statement (Aussage) for one piece. Fact, index and generation appear only in the technical area.
- Reminder threshold: 30 days, inclusive. Export it as `SOURCE_REMINDER_DAYS`.
- UI follows `docs/DESIGN_SYSTEM.md`. No horizontal overflow at 390 px.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- `VT <paths>` means `node --env-file=.runtime/local.env --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run <paths>`. Revert `evals/knowledge/last-deterministic-run.json` and `apps/web/next-env.d.ts` if a run touches them.

## Review Focus

- A card whose statement was edited to empty text must not be selectable and must not be sent (Task 3).
- A statement changed elsewhere while selected: confirm uses the version from current data; a stale one reports `VERSION_CONFLICT` and the rest continue (Task 3).
- A proposal whose draft is missing or has no `input.rights`: defaults apply, no crash (Task 3).
- Singular counts: "1 Aussage", "1 Vorschlag wartet", never "1 Aussagen" (Tasks 1 and 3).
- Long source names and long evidence quotes at 390 px do not overflow (Task 6).

---

### Task 1: Source row model

**Files:**
- Create: `apps/web/src/modules/knowledge/source-rows.ts`
- Create: `apps/web/src/modules/knowledge/source-rows.test.ts`
- Modify: `apps/web/src/modules/knowledge/workspace-text.ts`

**Interfaces:**
- Consumes: `Summary`, `visibleDrafts`, `listedSources`, `siteRunActive`, `analysisRunning` (`workspace-parts.tsx`); `sourceExpiry` (`overview.tsx`); `SourceIndexStatus` (`index-status.tsx`).
- Produces:

```ts
export const SOURCE_REMINDER_DAYS = 30;
export type SourceRowStatus = "reading" | "paused" | "failed" | "waiting"
  | "not_finished" | "never_read" | "out_of_date" | "reminder" | "up_to_date";
export type SourceRowAction =
  | { kind: "site-refresh"; sourceId: string }
  | { kind: "site-import"; sourceId: string }
  | { kind: "expert"; sourceId: string }
  | { kind: "resume"; sourceId: string }
  | { kind: "review" }
  | { kind: "draft-edit"; draftId: string }
  | { kind: "draft-update"; draftId: string };
export type SourceRow = {
  id: string;
  origin: "draft" | "source";
  entity: Entity;
  name: string;
  kindLabel: string;
  status: SourceRowStatus;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  sentence: string;
  lastRead: unknown;
  errorCode?: string;
  primary: SourceRowAction | null;
};
export function sourceRows(
  data: Summary,
  index: Map<string, SourceIndexStatus>,
  now: number,
  t: KnowledgeCopy,
  locale: string,
): SourceRow[];
```

Status is the first match of the spec table. Primary actions:

| Status | Draft | Source |
| --- | --- | --- |
| reading | null | null |
| paused | n/a | `resume` |
| failed | `draft-edit` | `site-refresh` |
| waiting | `review` | n/a |
| not_finished / never_read | `draft-edit` | website or gitbook: `site-import`; other: `expert` |
| out_of_date | n/a | with `data.site`: `site-refresh`; website or gitbook without it: `site-import`; other: `expert` |
| reminder | `draft-update` (only github or website) | n/a |
| up_to_date | null | null |

A draft is `not_finished` when no run with `draftId` has status `completed`. A source is `never_read` when `sourceExpiry` is `stale` with no `expiresAt`. A site run counts as failed only when its status is `failed` and `errorCode` is neither `SOURCE_INACTIVE` nor `KNOWLEDGE_DISABLED`. Runs arrive newest first. Sort rank: failed, waiting, not_finished and never_read, out_of_date, reminder, reading, paused, up_to_date; then `name` with `localeCompare`. `expiring` stays `up_to_date` with tone `warning` and the existing `expiringHint` sentence. `manual` freshness and `manual`/`file` drafts use the existing `manualSource` label.

New copy (add only keys that do not exist; reuse `freshSource`, `paused`, `neverRead`, `staleSource`, `manualSource`):

| Key | de | en |
| --- | --- | --- |
| `rowReading` | Wird gelesen | Reading |
| `rowFailed` | Fehlgeschlagen | Failed |
| `rowWaitingOne` | 1 Vorschlag wartet | 1 proposal waiting |
| `rowWaiting` | {n} Vorschläge warten | {n} proposals waiting |
| `rowNotFinished` | Nicht fertig | Not finished |
| `rowNotFinishedHint` | Die Einrichtung dieser Quelle ist noch nicht abgeschlossen. | Setting up this source is not finished yet. |
| `rowReminder` | Länger nicht gelesen | Not read for a while |
| `rowReminderHint` | Zuletzt vor {n} Tagen gelesen. Aktualisiere die Quelle, wenn sich dort etwas geändert hat. | Last read {n} days ago. Update the source if something changed there. |

- [ ] **Step 1: Write failing tests** in `source-rows.test.ts`, one `it` each: every status of the table for its origin with the primary action above; `paused beats out of date`; `reading beats failed`; `failed beats waiting`; `reminder at exactly 30 days and not at 29`; `no reminder for manual and file drafts`; `SOURCE_INACTIVE and KNOWLEDGE_DISABLED are not failed`; `replaced drafts and revoked sources produce no row`; `sort follows the rank, then the name`; `one waiting proposal uses the singular`; `needs_review proposals count as waiting`.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/source-rows.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `sourceRows` and the copy.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(knowledge): model one row per source`.

---

### Task 2: Source list with one primary action

**Files:**
- Create: `apps/web/src/modules/knowledge/source-list.tsx`
- Modify: `apps/web/src/modules/knowledge/workspace.tsx` (remove `SourceList`, `ManagedSource`), `apps/web/src/modules/knowledge/workspace.test.tsx` (`source list`, `managing confirmed knowledge`, `site runs and analysis outcomes`), `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `sourceRows`, `SourceRow`, `SourceRowAction` from Task 1. `Proposal` stays imported from `workspace.tsx` until Task 4 moves it, so export it.
- Produces: `export function SourceList({ data, refresh, t }: { data: Summary; refresh: () => void; t: KnowledgeCopy })`.

Each row: `id="knowledge-source-<row.id>"`, `tabIndex={-1}`, focus class for `?source=`; name, `kindLabel`, Badge, sentence, last read, `SiteRunSummary` for a site source, `WorkspaceError` for `errorCode`; one primary control. Primary labels: `resume` Fortsetzen / Resume; `site-refresh` on failed Erneut versuchen / Try again, otherwise Aktualisieren / Update; `site-import` Inhalte einlesen / Read in content; `expert` Verwalten / Manage (existing `manageSource`); `review` Prüfen / Review linking to `knowledge-review`; `draft-edit` on failed Erneut versuchen, otherwise Weiter einrichten / Continue setup; `draft-update` opens the existing confirmation modal, then `knowledge-draft-preview`.

"More" (Mehr / More) is a `<details>` menu following `apps/web/src/platform/shell/user-menu.tsx` (closes on outside click and Escape). Entries keep today's conditions: Edit (draft) or Manage (source); Pause; Weekly updates checkbox; History (draft proposals, opens below the row); Library; Remove. An entry that is the row's primary action is not repeated. Render "More" only when it has entries; no actions at all for non-owners except Library.

- [ ] **Step 1: Write failing tests** in `workspace.test.tsx`: `a row shows one primary control and its status`; `a reader sees status without actions`; `a failed draft keeps its reason`; `a GitHub draft read 30 days ago offers Update`; `text drafts offer no Update`; `?source focuses a draft row too`. Update older `source list` expectations that pinned the removed layout, keeping each test's intent.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/workspace.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the component and move the code. Style `.knowledge-source` rows and the menu in `globals.css`.
- [ ] **Step 4: Run** the same command and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): show every source as one row with one next step`.

---

### Task 3: Statement grouping and bulk model

**Files:**
- Create: `apps/web/src/modules/knowledge/statements-model.ts`, `apps/web/src/modules/knowledge/statements-model.test.ts`
- Modify: `apps/web/src/modules/knowledge/workspace-text.ts`

**Interfaces:**
- Produces:

```ts
export const TOPICS = ["description", "audience", "platforms", "features", "limitations"] as const;
export type StatementEdit = { statement?: string; marketing?: boolean; support?: boolean; publicUse?: boolean };
export type EffectiveRights = { marketing: boolean; support: boolean; publicUse: boolean };
export function groupByTopic<T extends Entity>(items: T[]): Array<{ topic: (typeof TOPICS)[number]; items: T[] }>;
export function effectiveRights(p: Entity, drafts: Entity[], edit?: StatementEdit): EffectiveRights;
export function effectiveStatement(p: Entity, edit?: StatementEdit): string;
export function selectable(p: Entity, drafts: Entity[], edit?: StatementEdit): boolean;
export function bulkSummary(selected: Entity[], drafts: Entity[], edits: Record<string, StatementEdit>, t: KnowledgeCopy): { text: string; needsPublicNote: boolean };
export type BulkResult = { done: string[]; failed: Array<{ id: string; code: string }> };
export function confirmAll<T extends { id: string }>(items: T[], send: (item: T) => Promise<void>, codeOf: (error: unknown) => string): Promise<BulkResult>;
```

`effectiveRights` precedence: edit, then the draft's `input.rights`, then Marketing and Support on and public off. `selectable`: status `pending`, trimmed effective statement not empty, at least one audience. `groupByTopic` hides empty topics; an unknown topic joins `description` (schema forbids it, data may predate it). `confirmAll` runs strictly one after another and never rejects.

Summary text: all selected share audiences: `12 Aussagen · Marketing und Support · 5 öffentlich`; mixed: `12 Aussagen · Marketing 8 · Support 11 · 5 öffentlich`. English: `12 statements · Marketing and Support · 5 public`; `12 statements · Marketing 8 · Support 11 · 5 public`. Singular `1 Aussage` / `1 statement`. `needsPublicNote` is true when any selected statement is not public. Result line: `{done} von {total} bestätigt` / `{done} of {total} confirmed`. Add keys `bulkConfirm` (Auswahl bestätigen / Confirm selection), `selectAll` (Alle auswählen / Select all), `noAudienceHint` (Wähle unter „Anpassen“ mindestens Marketing oder Support. / Under Adjust, choose at least Marketing or Support.), `adjust` (Anpassen / Adjust), `otherKnowledge` (Weitere / Other), `changedGroup` (Geändert / Changed), `moreEvidence` (Mehr zum Beleg / More about the evidence).

- [ ] **Step 1: Write failing tests**, one `it` each: `groups in topic order and hides empty topics`; `rights come from the draft`; `a card edit beats the draft`; `a missing draft or missing rights gets the defaults`; `an empty edited statement is not selectable`; `no audience is not selectable`; `needs_review is not selectable`; `summary for uniform rights`; `summary for mixed rights`; `summary singular in both languages`; `needsPublicNote when any is internal`; `confirmAll sends one at a time in order` (assert the second `send` starts after the first resolved); `confirmAll continues after a failure and reports the code`.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/statements-model.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): model topic groups and bulk confirmation`.

---

### Task 4: Grouped knowledge, review cards and bulk bar

**Files:**
- Create: `apps/web/src/modules/knowledge/statements.tsx`
- Modify: `apps/web/src/modules/knowledge/workspace.tsx`, `apps/web/src/modules/knowledge/source-list.tsx` (import `Proposal`), `apps/web/src/modules/knowledge/workspace.test.tsx`, `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: everything from Task 3; `action`, `useMutation` from `@/lib/api`. Read the error code the way `useMutation` does.
- Produces: `export function StatementList({ data, review, query, listingRemoved, refresh, t }: …)`, and `Proposal`, `ProposalHistory` moved here unchanged except as below.

`StatementList` holds `edits: Record<string, StatementEdit>` and `selected: Set<string>`, prunes ids that are no longer listed, and renders: a Changed group first (review only, no checkbox), then `groupByTopic`, then Other for older facts (not in review). Each heading shows the count; in review, owners get Select all for its selectable cards. The topic select is removed; search stays.

Review card (`review && !changed`): statement as text; source name (`draft.input.name`); open evidence (quote, `path · start–end`, link); reason; one rights line from `effectiveRights`; for owners a checkbox labelled by the statement, Confirm, Reject, Adjust. Confirm sends the card's effective values. Adjust opens today's form, which writes to `edits`. `noAudienceHint` shows when no audience is set. Stage hint, commit, Library and history move under `moreEvidence`.

Bar: renders when `selected.size > 0`, class `knowledge-bulk-bar`, `position: sticky; bottom: 0`, above the mobile bottom navigation. Shows `bulkSummary`, the existing `publicNeeded` note when `needsPublicNote`, and Confirm selection, disabled while running. Afterwards: the result line, `done` ids deselected, failed ids stay selected with their `WorkspaceError` on the card, `refresh()` exactly once. Send `{ proposalId, version, decision: "accept", statement, publicUse, audiences }` with `version` from the current list.

- [ ] **Step 1: Write failing tests** in `workspace.test.tsx`: `knowledge is grouped under topic headings with counts`; `older facts appear under Other`; `the review card shows the evidence without opening anything`; `the review card names its source and rights`; `changed statements come first and have no checkbox`; `a reader sees no checkboxes or bar controls`; `the card offers Adjust instead of an open form`; `the topic select is gone`. Update older expectations on the review form, keeping each test's intent.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/workspace.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** and move the code.
- [ ] **Step 4: Run** the same command and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): group knowledge by topic and confirm in bulk`.

---

### Task 5: Plain language and the technical area

**Files:**
- Create: `apps/web/src/modules/knowledge/technical-nav.tsx`, `apps/web/src/modules/knowledge/expert-text.ts`
- Modify: `apps/web/src/modules/knowledge/workspace.tsx` (gate, heading sentence, remove the Advanced fold), `apps/web/src/modules/knowledge/knowledge.tsx`, `apps/web/src/modules/knowledge/workspace-text.ts`, `apps/web/src/components/ui/primitives.tsx`, `apps/web/src/modules/knowledge/workspace.test.tsx`, `apps/web/src/app/globals.css`

**Interfaces:**
- Produces: `export function TechnicalNav({ tab }: { tab: KnowledgeTab })`; `export const expertCopy: Record<"de" | "en", …>`; `export function expertValue(value: unknown, locale: string): string`; `Status` gains optional `label?: string`, printed instead of the value when given.

Gate: when workspace `enabled` and rendering `fallback`, render `<><TechnicalNav tab={tab} />{fallback}</>`. With the workspace off nothing changes.

`TechnicalNav` entries and targets (`hrefOf` + `?expert=1`), de / en: Quellen / Sources (`knowledge-sources`), Fakten / Facts (`knowledge-facts`), Konflikte / Conflicts (`knowledge-conflicts`), Import / Import (`knowledge-import`), Bibliothek / Library (`knowledge-library`), Zustand / Status (`knowledge-health`), Suchprüfung / Search check (`knowledge-inspector`), Betroffene Inhalte / Affected content (`knowledge-impact`); GitHub-App / GitHub App (`knowledge-github`, owners, no `?expert`); Zurück zum Wissen / Back to knowledge (`knowledge`). The current tab has `aria-current="page"`.

Workspace pages: replace the fold by one link Technik-Bereich / Technical area to `knowledge-health?expert=1`. Page sentences (`hint`), de / en:
- Project knowledge: Das hast du aus deinen Quellen bestätigt. Orbit nutzt nur dieses Wissen. / What you confirmed from your sources. Orbit uses only this knowledge.
- Sources: Woher dein Wissen kommt und was als Nächstes zu tun ist. / Where your knowledge comes from and what to do next.
- To review: Vorschläge aus deinen Quellen. Erst nach deiner Bestätigung werden sie zu Wissen. / Proposals from your sources. They become knowledge only after you confirm them.

Replace "Erkenntnis" and any other synonym in `workspace-text.ts` by the terms of the constraints.

`knowledge.tsx`: every hard-coded label goes through `expertCopy`. `health-stats` and health section headings use named labels (Konflikte / Conflicts, Abgelaufene Fakten / Expired facts, Fehlgeschlagene Importe / Failed imports, Veraltete Quellen / Out-of-date sources, Betroffene Inhalte / Affected content). The health page's `keys` drops `missingEvidence`. The two fallback strings there ("Affected object", "Review the current source…") are translated. `<Status>` calls pass `label={expertValue(value, locale)}`. `expertValue` maps the source types, statuses and enums used on these pages; an unmapped value returns the generic Unbekannt / Unknown. Item headings prefer `key`, `title`, then a name; an id is shown only when none exists, in a secondary line.

- [ ] **Step 1: Write failing tests** in `workspace.test.tsx`: `the technical bar appears on expert pages with the workspace on`; `the bar is absent with the workspace off`; `every expert URL still renders` (each tab with `?expert=1`); `health shows named sections and no missing evidence`; `impact shows Affected content`; `no raw status or source type is printed` (`verified_facts`, `needs_review`); `the Advanced fold is replaced by one link`; `an unknown value prints Unknown`; plus a guard reading `knowledge.tsx` as text: no match for `/<(dt|h2|h3|summary|th)>[A-Z][a-z]/`.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/workspace.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `VT apps/web/src/platform/shell` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): add the technical area and plain wording`.

---

### Task 6: Browser flow, documentation and full verification

**Files:**
- Modify: `apps/web/tests/knowledge-workspace.spec.ts`, `docs/KNOWLEDGE_WORKSPACE.md`, `docs/IMPLEMENTATION_STATUS.md`

- [ ] **Step 1: Extend the browser spec** at both viewports: from To review, select one topic, read the bar, confirm, assert the result line and that the statements appear under their topic in Project knowledge; a row on Sources has one primary control and a working More menu; a statement with a long name and quote causes no overflow (`expectNoOverflow`); the Technical area link opens the bar and Back to knowledge returns.
- [ ] **Step 2: Run** the browser spec through the scratchpad script `e2e.sh` named in the ledger. Expected: 2 passed.
- [ ] **Step 3: Update docs.** `KNOWLEDGE_WORKSPACE.md`: replace the source and statement paragraphs with the row model, the reminder, bulk confirm and the technical area. `IMPLEMENTATION_STATUS.md`: a new top section, stating implemented, not merged, not deployed.
- [ ] **Step 4: Run** `pnpm lint`, `pnpm typecheck`, `VT` with no paths, `pnpm build`, `node scripts/boundaries.mjs`, `git diff --check`, and the design detector on `apps/web/src/modules/knowledge`. Expected: all pass; report exact totals. Confirm `git diff origin/main --name-only` holds only `apps/web/**` and `docs/**`.
- [ ] **Step 5: Commit** `docs(knowledge): describe source rows, bulk confirm and the technical area`.
