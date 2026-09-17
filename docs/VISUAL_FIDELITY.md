# Visual fidelity ledger

## References and rendered evidence

Image Gen produced the complete references before implementation:

- `apps/web/design/overview-desktop.png` — 1536 × 1024.
- `apps/web/design/overview-mobile.png` — mobile 390 × 844 proportions, generated at higher raster resolution.
- `apps/web/design/knowledge-desktop.png` — 1536 × 1024.

The root agent first opened the real application through Browser/IAB and inspected the login surface. Authenticated Playwright then exercised the actual local API and worker in installed Google Chrome **152.0.7977.84**, using an isolated browser context and synthetic local accounts. There were no route mocks or paid application calls.

Retained browser screenshots:

- `apps/web/design/actual/overview-desktop.png` — 1536 × 1024 viewport; full document capture includes the footer at 1076 px.
- `apps/web/design/actual/knowledge-desktop.png` — 1536 × 1024.
- `apps/web/design/actual/overview-mobile.png` — exact 390 × 844 viewport.
- `apps/web/design/actual/overview-mobile-full.png` — full vertical continuation at 390 px.
- `apps/web/design/actual/knowledge-mobile.png` — full vertical continuation at 390 px.
- `apps/web/design/actual/community-desktop.png` — real grouped synthetic questions at 1280 × 720.
- `apps/web/design/actual/operator-mobile.png` — owner index generation and Health continuation at 390 px.

All three concepts and the latest desktop/mobile captures were opened with `view_image` in the same acceptance pass. Full-page screenshots retain the fixed navigation at its viewport position; this is a screenshot characteristic, not a second navigation bar. The exact viewport capture shows the actual first screen.

## Comparison and repair ledger

| Comparison               | Concept evidence                                                                                      | Render evidence / disposition                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original brand           | Overview reserved a mark position alongside EDS Orbit                                                 | Original EDS Labs SVG fills this position unchanged. It is also visible at 390 px. Hash/provenance is in `ASSET_MANIFEST.md`; brand usage rights remain separate.                                                                                                     |
| Desktop geometry         | Left rail, thin header, aligned objective, mode band, three metrics, mission/readiness pair, activity | Same composition and 232 px rail. The 64 px authenticated header and larger readable card spacing add 52 px of vertical continuation to the full Overview compared with the concept; no content is clipped.                                                           |
| Palette and surfaces     | Cool Arctic white with blue illumination, navy mode surface, restrained primary blue                  | Same cool temperature and token colors, readable stable white content surfaces, restrained borders and shadows. No warm palette substitution or decorative raster background.                                                                                         |
| Hierarchy and typography | Objective first, short supporting line, one primary task                                              | Preserved. System font, explicit 36 px desktop / 29 px mobile title, compact 12–14 px controls, 16 px mobile inputs. Long mobile forms retain readable field sizes instead of shrinking to fit a screenshot.                                                          |
| Mobile mode banner       | Short “Observe mode / External publishing is off.”                                                    | Initial long desktop copy caused accidental wrapping. Repaired with the concept’s short mobile copy and a three-column icon/text/action layout. Latest capture has a single-line mode heading and visible setup action.                                               |
| Knowledge composition    | Six tabs; source list and search; separate right inspector; three knowledge distinctions              | Preserved at desktop. Inspector stacks below sources at 390 px. Tab row scrolls independently; keyboard End selects/focuses Impact without page overflow. All actual timestamp states remain distinct.                                                                |
| Icon system              | Thin, consistent outline navigation and empty-state icons                                             | Lucide outlines, consistent optical sizing and strokes. Wallet represents spend, Brain represents memory, and the original logo is never substituted by an icon. Unified pale-blue active navigation follows the Overview concept across all screens.                 |
| Container rhythm         | Stable panels, open gutters, restrained radii                                                         | Preserved. Knowledge distinction links use open divided rows rather than three extra bordered cards; this avoids competing with the source/inspector surface.                                                                                                         |
| Mobile continuation      | One column, project selection, full-width primary action, five-item bottom navigation                 | Preserved. Real readiness includes the spending-limit requirement and recent activity continues below it; both are kept accessible by scrolling instead of removing operational information to match the shorter generated mobile concept.                            |
| Small desktop / keyboard | All workspace controls must remain usable                                                             | 1280 × 720 testing found sign-out below the fixed rail. Repaired with scrollable navigation and nonshrinking children. Viewer login/logout test now passes. Native dialogs and drawer support Escape; form Tab movement was exercised.                                |
| Debug and loading states | No developer chrome; calm progressive state                                                           | Next development indicator disabled after it appeared in the first capture. Final reference captures wait for the actual content rather than capturing a transient skeleton. Reduced-motion media was exercised; motion/transparency fallbacks are defined centrally. |

## Above-the-fold copy comparison

Preserved: “Your marketing, in orbit.”, its supporting sentence, “New mission”, “Observe mode”, “Review setup”, the three metric meanings, “Mission control”, “Start with a clear objective”, “Create mission”, “Readiness”, and all eleven desktop navigation destinations. Knowledge preserves “Trusted context. Traceable decisions.”, all six tab names, “Your sources”, “Source details”, “Build your source of truth”, and “Add source”.

Intentional functional differences:

- The selected synthetic project name and account initial reflect authenticated data; they are not seeded marketing claims.
- Real readiness adds its state and expandable blocker details. Counts derive from active mission states and open exceptions; missing budget remains unavailable, not zero.
- The footer states that external actions require a valid mandate. Sign out, project creation, language controls and the RC version are real application controls/information.
- “View all” is shared across sections rather than repeating “View all missions/activity”.
- The Knowledge concept’s invented “Build with trust” sidebar tagline and decorative waves are omitted. The original brand mark takes precedence over the generated blank reservation.
- Mobile keeps actual spending readiness and activity, leading to a longer page than the generated concept. The full first-screen call to action remains available.

No unaccounted hero labels, fake metrics, fictional charts, substitute logos or decorative agent imagery were added. The design system and primary composition were faithfully verified against the implementation references with the explicit differences above; this is a local implementation review, not a claim of user or agency sign-off or pixel-identical raster reproduction.

## Functional browser evidence

Final command:

```sh
PLAYWRIGHT_CHANNEL=chrome node node_modules/@playwright/test/cli.js test
```

Result: **4 passed in 25.4 seconds** on 2026-09-17, against localhost web 4310, API 4311 and the real local worker. The optional channel selects installed Chrome locally; CI can use the pinned Playwright browser. Sign-in tests honor the server’s Retry-After throttle rather than disabling authentication limits.

1. Actual sign-in → isolated project → public manual source/document → verified fact → lexical-degraded retrieval → mission → persisted worker-generated test content → review → derived channel adaptation with retained lineage → exact-version approval → `published_test` → blog metadata and schedule → calendar → source revocation → content `needs_review`.
2. 390 × 844, no horizontal page overflow, mobile drawer Escape, form Tab/Escape, German/English and document language, reduced-motion emulation, keyboard tab navigation, real Operations worker heartbeat/outbox surface.
3. Owner creates a local viewer through Settings; actual logout/login, visible read-only state, hidden owner mutations, and server rejects source write with 403.
4. Local brief proposal → manually completed mission (no invented counts/dates; live publication remains off) → authorized private question import → lexical grouping with a separately flagged complaint → versioned mission linkage → manual calendar block and release → exact fact-version withdrawal persisted as `revoked` → owner index preparation and missing Matomo connection boundaries → Health at 390 px without overflow.

The final primary captures and both added editorial/operator captures were opened for visual inspection. The additions reuse existing panel, table, alert and form geometry; the original primary layouts and copy remain stable. Operator generation controls wrap on mobile, code/hash text wraps within the surface, and private community rows retain clear review state. Index controls are mounted only for owners, matching the API's owner-only read permission.

Six additional PostgreSQL integration tests in `apps/api/src/modules/editorial.integration.test.ts` verify authorization, idempotent imports, review grouping, project isolation/version fences, conservative brief extraction, adaptation lineage/duplicate rejection and current source rights. Matomo live report reads, paid embedding/evaluation, Postiz publication proof and workspace-wide pause were not executed by browser acceptance. Their forms call real server actions; live external proof remains a separate operator action.

Web TypeScript 6.0.3 check also passed with no diagnostics. Backend unit/integration, security and production build evidence are tracked by the root verification documents. These browser tests do not establish live provider delivery, paid model quality, production readiness or deployment.

## Root production-build verification

After the final application build, root repeated the same complete four browser workflows against `next start` with the real local API and freshly restarted worker: **4/4 passed in22.7seconds**. Canonical log: `docs/evidence/browser-tests.log`. This is local production-build verification, not remote deployment or live provider acceptance.
