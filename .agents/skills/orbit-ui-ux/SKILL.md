---
name: orbit-ui-ux
description: Build, refine, or review UI and UX in the EDS Orbit web app, including module views, sidebar and mobile navigation, and administration. Use for inconsistent spacing, alignment, iconography, list and table layout, and mobile rendering.
---

# Orbit UI/UX

## Name

`orbit-ui-ux`

## Zweck

Keep Orbit's web app consistent across modules, administration and mobile navigation.

## Auslöser

Use this skill for Orbit web UI implementation, responsive fixes and visual reviews.

## Voraussetzungen

Start with the [Orbit design system](../../../docs/DESIGN_SYSTEM.md). Use its Arctic Blue / Liquid Glass palette, typography and appearance modes. For changes to the shell, home, module navigation or settings, also read the [navigation and layout spec](../../../docs/superpowers/specs/2026-10-18-orbit-ui-restructure-design.md) alongside the current design system and implementation.

## Vorgehen

### Reuse Orbit patterns

- Read the affected view and a comparable Orbit view in the same shell before changing layout. Reuse the [shared primitives](../../../apps/web/src/components/ui/primitives.tsx) and [platform UI components](../../../apps/web/src/platform/ui/), including `PageHead`, `DataList`, `EntityRows`, `DataForm`, `Status`, `Modal` and `Sheet` where they fit the interaction. Keep module-specific layout in the owning module.
- Use the existing spacing and surfaces in [globals.css](../../../apps/web/src/app/globals.css) and the shared color variables in [appearance.css](../../../apps/web/src/app/appearance.css). Align headings, toolbars, notices and list content to their container's inset. Keep spacing within a row tighter than the gap between sections, and use the shared layout's padding and gaps to keep wrapped content on the same text column.
- Use Lucide outline icons at the existing component sizes. Follow [navigation-icons.ts](../../../apps/web/src/platform/shell/navigation-icons.ts) for module and settings groups so the same concept uses the same icon in the sidebar, mobile drawer, settings and overview cards. Use shared button variants for actions. Give icon-only controls localized accessible names and hide redundant decorative icons from assistive technology.
- Structure list rows around a readable title, secondary metadata, a text status when relevant, and a predictable action position. Keep comparable rows aligned and let longer titles and labels grow vertically. Keep route links and action buttons separately operable. Use tables for comparing columns and preserve their headers and sort controls.
- Keep page headings, forms and data states consistent across views. Use existing loading, empty, error, disabled and pending patterns where applicable. Preserve keyboard access, visible focus, localized labels, deep links and permission-based controls.

### Compose for narrow screens

- Follow the shell's 760 px mobile breakpoint. Stack filters, controls and inspectors when their content needs room. Let action labels wrap and keep the primary action visible and reachable. Use the existing 44 px mobile targets and 16 px mobile form text.
- Check that grid and flex children can shrink and that long names, translated labels and badges wrap within their own region. Keep horizontal scrolling local to content that needs it, such as a comparison table or calendar. Give intentional scroll regions a label and keyboard access, and preserve any available list view.
- Check the whole screen in the real shell. Verify that the bottom navigation and assistant button leave room for the final row or action, the drawer and sheets handle focus, and controls remain reachable when the viewport shrinks or the keyboard is open. Follow the existing safe-area and mobile navigation spacing.

### Review and verify

- For a reported layout issue, reproduce it in the affected route with the relevant data state. Check the rendered view and its containers before changing CSS. For a broad audit, record coverage by route and viewport, including the shell, administration/settings and affected module views. Report what you observed and identify gaps in coverage.
- For changes to visible layout, check a desktop view and narrow mobile views at 320 px and 390 px in the browser. Check both sides of the 760 px breakpoint for changes to responsive behavior. Use a populated view with long German or English labels, plus the states affected by the change. When appearance styles change, check light and dark. Use WebKit for Safari-specific, safe-area or mobile input behavior where relevant.
- For visual regressions, capture before-and-after screenshots at matching viewport and state where possible. Verify the concrete behavior, such as aligned title and alert insets, no page-level horizontal overflow, an operable row menu or a reachable final action. Use the existing [Playwright tests](../../../apps/web/tests/) for the affected flow. [Knowledge layout](../../../apps/web/tests/knowledge-layout.spec.ts) shows how to combine visual inspection with targeted assertions.

## Erwarteter Output

Report the affected views, the observed layout or interaction and the browser evidence for each fix. Include route and viewport coverage for broad audits.

## Sicherheitsregeln

Preserve server authorization and permission-based controls. Use synthetic data for local visual fixtures and honor Orbit's approval rules for production actions.

## Abschlusskriterien

The affected views follow the existing Orbit patterns. Relevant layout and interaction checks pass, and the report makes any verification gaps clear.
