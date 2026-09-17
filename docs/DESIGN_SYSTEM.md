# EDS Orbit design system

## Scope and source

The user selected the existing EDS Labs Arctic Blue / Liquid Glass system. The implementation follows `apply-eds-labs-ui-style` and `frontend-app-builder`. The Next.js custom backend preset is fixed by the master; React/Vite is a plausible smaller client alternative, but would replace the expressly selected application framework.

Three complete concept images were generated before UI implementation with the built-in Image Gen tool, without application API credentials or paid application test calls:

- `apps/web/design/overview-desktop.png` — 1536 × 1024 primary overview, honest empty installation.
- `apps/web/design/overview-mobile.png` — mobile overview including the readiness continuation and bottom navigation.
- `apps/web/design/knowledge-desktop.png` — 1536 × 1024 source list and source inspector.

The master authorizes implementation without a design approval stop. These are implementation reference concepts, not a claim of user sign-off. They contain no live results. Production views start empty and consume the actual authenticated API.

## Tokens

| Purpose                  | Value                                        |
| ------------------------ | -------------------------------------------- |
| Canvas                   | `#f7fcff`, restrained `#eef8ff` illumination |
| Primary text             | `#071522`                                    |
| Secondary / muted        | `#60738a`                                    |
| Primary action           | `#0969ff` → `#1685ff`                        |
| Mode surface             | `#0e2739` → `#1b3447`                        |
| Readable content surface | white / 76% white over a stable light canvas |
| Border                   | `#dceaf4`                                    |
| Success                  | `#17725a` on `#e3f5ee`                       |
| Warning                  | `#85651c` on `#fff4db`                       |
| Error                    | `#ae3647` on a very pale rose surface        |
| Panel radius             | 10–12 px                                     |
| Control radius           | 8–9 px                                       |
| Modal radius             | 18 px desktop / 14 px mobile                 |

The typography uses system Inter fallbacks, 0 tracking, fixed breakpoint-specific sizes and no downloaded font. Desktop titles are 36 px (31 px on smaller desktops), mobile 29 px. UI controls are 12–14 px; mobile form fields use 16 px to prevent iPhone focus zoom. Long reading surfaces are opaque and high contrast.

## Composition

The desktop uses a 232 px glass navigation rail, 64 px header and 30 px workspace gutters. The overview places its objective above a single navy operating-state strip, then three factual metrics, a mission/readiness pair and an activity list. Knowledge uses a wide source list and a 300 px inspector. Tables, lists, forms and content previews share a stable reading surface; there are no animated fictional agents or fabricated analytics.

At 760 px and below, navigation moves to a focus-managed drawer and a five-item bottom bar. Forms and inspectors stack; primary actions remain visible. Tab rows scroll without stretching the page. Schedule editing uses an accessible form rather than requiring drag and drop. The project timezone is displayed; datetime fields explicitly use browser-local time and submit UTC instants.

## Components and behavior

The code-owned UI primitives use shadcn-compatible composition (CVA Button variants, Radix Slot `asChild`, FieldGroup/Field, Input/Textarea, Alert, Badge, Skeleton, Empty) and Lucide outline icons. Native dialogs provide focus trapping, Escape behavior and an accessible title. Theme choices are centralized in `apps/web/src/app/globals.css`.

Every data view has loading, empty and API error states. Mutations have a pending lock, server-derived errors and success feedback. A project-scoped React context controls role presentation; server authorization remains authoritative. Viewer controls are read-only. Source/fact/policy/credential and brand-rights changes use owner controls matching API permissions.

No displayed conversion rate, spend limit or outcome is seeded or invented. Unknown values render as unavailable (`—`). Local storage contains only the interface locale and last selected project ID, never content, approvals or credentials.

## Accessibility and reduced effects

- Visible 3 px focus outline and skip-to-content link.
- Semantic headings, tables, forms, labels and status/error regions.
- Keyboard tabs support Arrow, Home and End; dialogs support Escape.
- Mobile navigation traps focus while open and restores the triggering focus.
- Native validation plus server validation; no offline mutations.
- `prefers-reduced-motion` removes transitions, spinners and shimmer motion.
- `prefers-reduced-transparency` replaces blur/translucency with stable opaque surfaces.
- Forced-colors mode preserves boundaries and selected states.

## Concept prompts

The desktop prompt requested the full Overview, exact navigation, Observe banner, zero missions/decisions, unconfigured budget, readiness checklist and activity empty state in the original brand palette. The mobile prompt requested the complete 390 × 844 proportioned primary screen with project selection, objective, primary action, mode banner, metrics, mission empty state, readiness continuation and bottom navigation. The Knowledge prompt requested all six tabs, source list/search, source inspector, separate fetched/indexed/verified times and a clear boundary between facts, documents and marketing memory. All explicitly prohibited invented logos, live metrics, fictional charts and decorative agents.

## Editorial and operator additions

Content Studio includes private, labeled community question imports and lexical groups. A question group can be linked to a mission or answer draft; imported questions do not become approved facts and this flow never sends replies. Reviewed content can produce a draft social adaptation with parent/version lineage, retained current evidence and channel duplicate checks. Missions accept a conservative local brief proposal, require explicit unknown fields, and expose product/topics and a default-off owner live-publication allowance.

The Calendar presents manual owner blocks and flags scheduled content that overlaps them. Knowledge Health exposes owner index generations, explicit paid build/evaluation forms and guarded activation/rollback. Facts support versioned withdrawal. Analytics includes an aggregate Matomo import form. Operations offers an explicit workspace-wide pause/resume confirmation. Settings shows the API's readiness per capability.

Postiz write verification separates preparing a fixed package from approving its exact account/text/optional approved PNG and reconciling the outcome. The package surface includes instance/version, expiry, hash and cleanup disclosure. An accepted request is displayed as its real state, never as verified delivery. All operator errors remain server-derived; these UI surfaces do not create credentials, budgets or live authorization automatically.
