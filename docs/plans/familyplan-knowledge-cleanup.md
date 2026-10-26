# FamilyPlan knowledge clean-up (P2): inventory and plan

Status: **inventory and plan, 2026-10-26. Nothing has been changed.** Every change below needs Mario's approval; fact withdrawals and document revocations are irreversible in their effect on dependent content (they stay in the version history).
Read live (read-only) in Orbit production with Mario's session, project `118371ad-5f28-4397-9cef-877cbb1ffbe1`, on 2026-10-26.

## 1. Current state

- **Facts:** 20 verified (the report of 2026-10-25 counted 18), all German. 16 public, 2 internal.
- **Sources:** 17. Thirteen website sources of type `verified_facts` (three named "FamilyPlan Webseite", ten "FamilyPlan Webseite (vollständig)"), three "FamilyPlan – GitHub-Repository" sources (one public, two internal for Marketing and Support), and the curated source `7179fa92` "FamilyPlan – Kuratierte Projektwissensbasis 2026-10" (manual, internal, generation 2).
- **Documents:** 29. Sixteen one-passage documents carry the text of one fact each; 13 documents of the curated source hold 96 of the index's 112 passages.
- **Index:** generation 2 active since 2026-10-26: 112 passages, the check passed (100 test questions, recall@10 0.93, no forbidden hit, 120 questions in total; writing the questions cost 0.16 USD).
- **Readiness:** the only remaining blocker is `PUBLISHER_WRITE_VERIFICATION_REQUIRED`.

## 2. Facts

| Fact | Source | Statement (short) | Proposal |
|---|---|---|---|
| `2ebf05c2` | Webseite | Product description | **Withdraw**: word-for-word duplicate of `b4d8c69c` |
| `718b3cf8` | Webseite | Assistant: shows changes one by one, saves after an adult's review | **Withdraw**: same statement as `fd32c88d` |
| `759efb7d` | Webseite | iPhone/iPad, web beta, Android testers wanted | **Withdraw**: covered by `83d45886` + `30bc87e4` |
| `d27d5349` | GitHub (public) | Location sharing and family map | **Withdraw (recommended)**: same as `6fcf6145`; a public product claim should cite the website, not the repository. The family map moves into the new Premium fact |
| `b4d8c69c` | Webseite (vollständig) | Product description | Keep |
| `fd32c88d` | Webseite (vollständig) | Assistant review rule | Keep |
| `83d45886` | Webseite (vollständig) | App Store, browser beta, Android closed test | Keep |
| `93ec8e46` | Webseite (vollständig) | Web version is a public beta, same family data | Keep |
| `30bc87e4` | Webseite (vollständig) | Android not released; closed Google Play test, 14 days | Keep |
| `6fcf6145` | Webseite (vollständig) | Voluntary location sharing | Keep |
| `5a60fe5a` | Webseite (vollständig) | Premium monthly/yearly with a free month; Free tier exists | Keep |
| `85d84017` | Webseite (vollständig) | Rewards for children | Keep |
| `20b2167f` | Webseite (vollständig) | Budget planning | Keep |
| `956fc1ef` | Webseite (vollständig) | Audience parents and children | Keep |
| `7dda1b58`, `4f879d6c`, `729043f1`, `f46abf08` | GitHub (public) | Official links: website, App Store, web beta, Android test | Keep (they back the four profile links) |
| `52fc578f` | GitHub (internal) | Cross-platform with one Supabase backend | Keep (internal, technically correct) |
| `be8a6f6d` | GitHub (internal) | iOS demo/offline mode without Supabase values | Keep (internal) |

**New facts** (public, source: the website, matching the production Supabase check of 2026-10-25):

1. `plans.free_features`: „In FamilyPlan Free sind Dashboard, Heute, Kalender, Aufgaben, Listen, Mahlzeiten, Rezepte und Budget enthalten.“
2. `plans.premium_features`: „FamilyPlan Premium enthält alle Free-Funktionen sowie Familienchat, Schule und Stundenplan, Belohnungen, Standorte mit Familienkarte und den KI-Assistenten.“

After the clean-up: 16 + 2 = **18 verified facts** without duplicates.

For each withdrawn fact, also revoke its one-passage document (`16038e34`, `84eb5042`, `4628bdff`, `1ab32b57`). Withdrawing a fact leaves that document in search; without the revocation the duplicate text would still be found.

## 3. Documents

| Document | Finding | Proposal |
|---|---|---|
| `b1217c5f` „Integration von FamilyPlan in EDS Orbit“ (10_ORBIT_INTEGRATION.md, version 2, 20.10.) | Status snapshot from 20.10.: no marketing profile, 0 facts, Postiz/Drive not connected, OpenAI not verified | **New version** with the current state (draft below); version 2 stays in the history and is marked historical in the text |
| `6692ee42` „Preise, Abonnements und Berechtigungen“ (06) | The matrix is correct; it says "entitlement mapping in code [PRÜFEN]" | **New version**: the entitlement mapping was checked against production Supabase on 2026-10-25 (`free`, `family_premium` as listed) |
| `53ace963` „Entscheidungen, Roadmap und offene Fragen“ (09) | Item 5 "store the marketing profile, verify Postiz/Matomo" is partly done | **New version** of item 5: profile v3 done; Postiz read verified; write verification and Matomo open |
| `8f12ff2d` (11), `9d8062c0` (03) | Already label the old GitHub README as historical | Keep |
| Other curated documents (00–05, 07, 08, marketing strategy) | No outdated status statements found | Keep |
| GitHub README with the old Free matrix | Not in Orbit; it lives in the private FamilyPlan repository | Update it in that repository (separate task) or leave it; Orbit already treats it as historical |

Planning content (strategy, roadmap) stays in the internal documents and never becomes a verified fact. Marketing and Support take product claims only from verified facts (K-1); with the outdated statements replaced, retrieval no longer offers them as current.

### Draft: 10_ORBIT_INTEGRATION.md, version 3

```markdown
# Integration von FamilyPlan in EDS Orbit
**Stand:** 26.10.2026 (in Orbit geprüft). Frühere Stände dieses Dokuments (Version 2 vom 20.10.2026) sind historisch: Damals fehlten Marketingprofil, verifizierte Fakten und Verbindungen.

## Projekt
- Workspace `Orbit`, ID `346b1b02-dea2-4870-a0c0-8e7f7a6dc30e`; FamilyPlan-Projekt-ID `118371ad-5f28-4397-9cef-877cbb1ffbe1`.
- Module: `knowledge`, `support`, `marketing`.

## Ist-Zustand
- **Marketingprofil:** Version 3 mit vier offiziellen Links: Website, App Store, Web-Beta, Android-Test. Markenfarben: Primär `#1E4A86`, Hintergrund `#F5F8FC`, Text `#111827`.
- **Wissen:** 18 verifizierte Fakten, ohne Dubletten. Pläne: Free mit Dashboard, Heute, Kalender, Aufgaben, Listen, Mahlzeiten, Rezepte und Budget; Family Premium zusätzlich mit Chat, Schule, Belohnungen, Standorten und Assistent (produktiver Supabase-Abgleich vom 25.10.2026).
- **Suchindex:** neue Generation nach dieser Bereinigung, geprüft und aktiv (Ergebnis siehe Wissen → Suchindex).
- **Google Drive:** verbunden, lesend verifiziert. Logo- und Designdateien liegen in Drive, sind aber noch nicht als freigegebene Bild-Assets in Orbit.
- **Postiz:** Facebook und Instagram lesend verifiziert. Veröffentlichen ist nicht schreibverifiziert (`PUBLISHER_WRITE_VERIFICATION_REQUIRED`).
- **Matomo:** für FamilyPlan nicht eingerichtet.
- **Blog, Newsletter, Ads:** nicht eingerichtet; für die erste organische Social-Testphase nicht nötig.

## Regeln
- Inhalte zuerst nur als Entwürfe; keine automatische Veröffentlichung; keine bezahlten Maßnahmen ohne gesonderte Freigabe.
- Produktaussagen nur aus verifizierten Fakten; Planungs- und Roadmapinhalte sind intern und keine Zusagen.

## Safety-Grenze
Orbit nutzt FamilyPlan-**Projektwissen**. Die Leseberechtigung für echte Familienkonten ist nicht Teil dieser Quellenfreigabe. Dafür wären eine eigene Schnittstelle und eine ausdrückliche Freigabe nötig. Kein projektübergreifender Zugriff mit uLiquid.
```

## 4. Order and the search index

Document changes and revocations change the indexed knowledge. The active generation 2 then no longer matches it: `LIVE_RAG_EVAL_REQUIRED` returns, and the new passages are found only by full-text search until a new generation is active. So all changes happen in one go, followed straight away by the check:

1. Withdraw the four facts and revoke their four documents (owner actions; each one confirmed).
2. Add the two plan facts.
3. Publish the new versions of 10, 06 and 09 (same `externalId`, so they are versioned updates).
4. Knowledge → search index: "Prepare new generation" (free) → embed (cents) → "Check" (about 0.16 USD for the questions, under 1 cent for the check) → review → "Activate".
5. Afterwards `project_readiness_get` should again show only `PUBLISHER_WRITE_VERIFICATION_REQUIRED`.

## 5. Decisions for Mario

1. Withdraw the four facts (including `d27d5349`) and revoke their documents?
2. Use the two plan facts as worded?
3. Use the draft of 10_ORBIT_INTEGRATION.md (and the changes to 06 and 09)?
4. GitHub README: update it in the FamilyPlan repository, or leave it?
