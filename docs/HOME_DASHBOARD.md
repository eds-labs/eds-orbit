# Project home dashboard

The project home keeps the greeting, assistant prompt, project status and
attention list above the dashboard. Use **Customize dashboard** to add or
remove widgets, move them with their drag handles or the widget options, and
choose **Compact** or **Wide**. The keyboard handle uses Space and the arrow
keys. The same order applies on phones, where all widgets take one column.

**Save** applies the draft across devices for the signed-in member in the
current project. **Cancel** discards the draft. **Restore default** followed
by **Save** restores the project's available default cards. An empty saved
dashboard stays empty. If another tab or device saves first, Orbit keeps
the draft visible and offers to load the current layout.

The standard layout includes the available Support, Work, Issues,
Marketing, Knowledge and Finance cards, followed by System status. The
catalog adds scheduled Social posts, shared Webmail mailboxes, Ads accounts
and the CMS publishing summary where their modules are available. Losing
access to a module hides its widget and stops its requests when the API's
module states reflect the change. If access returns, the saved placement
returns with it.

## Register a widget

Add a contribution to the owning module's `homeWidgets` in its web
manifest. Define a stable ID with the module ID as its prefix, short EN/DE
catalog text, a default size and a React component. Optional `defaultOrder`
opts a contribution into the standard layout. Use `feature` or `minAccess`
when a widget needs an additional gate beyond its module's. Keep IDs stable
across renames and visibility changes. Platform widgets use the same
contract through the web registry.

Use `HomeCard` for the card frame and the existing project API for
authorized data. Keep the visible result compact, with an empty state when
the member has no data. Keep widget loads read-only. The dashboard mounts
the placed, available widgets only. The catalog reads the manifest labels
and descriptions.

## Personal layout API

`GET /api/projects/:projectId/home-layout` returns the session member's
`{ revision, widgets }`. A missing row has revision `0` and `widgets: null`.
Send the same shape with `PUT`, using the last read revision. It returns
the updated revision and layout, or `409 HOME_LAYOUT_CONFLICT` if the
revision changed. `widgets` is an ordered array of unique `{ id, size }`
entries. `size` is `compact` or `wide`. The service accepts up to 100
entries and preserves IDs from unavailable module versions. `null` selects
the defaults and `[]` selects an empty dashboard.

The layout stores placement metadata only. Scope comes from the session and
the project's existing access rules, including organization owners
without a direct project membership. `ProjectHomeLayout` uses forced row
security for workspace, project and user. Its rows cascade with removal
of their project or user. Existing module endpoints continue to authorize
each widget data read.

## Rollout and recovery

`ORBIT_HOME_WIDGETS` defaults to `false`. The modules endpoint advertises it
as `features.homeWidgets`. The additive migration
`202611230001_project_home_layout` creates the separate table and its RLS
policy. No backfill is necessary.

Before a production push, verify the backup and restore path and obtain
approval for the migration and its Coolify schema hash as described in the
[Coolify deployment guide](deployment/COOLIFY.md#vm102-restore-git-deployments-after-the-server-migration).
Apply the migration with the flag off. After the activation is approved,
check the home page under an authenticated test account. Save a layout,
reload it, check that the legacy links and attention open, and monitor
unexpected 4xx or 5xx responses on the layout route. Disabling
`ORBIT_HOME_WIDGETS` restores the original grid and retains saved layouts.
Module switches are managed through their own rollout.

Local browser acceptance uses the isolated worktree database and a
synthetic browser account. Start the API and web app with
`ORBIT_HOME_WIDGETS`, `ORBIT_MODULES`, `ORBIT_SOCIAL`, `ORBIT_WEBMAIL`,
`ORBIT_ADS` and `ORBIT_CMS` enabled in the API. Keep external writes disabled.
Run `E2E_HOME_WIDGETS=1 pnpm test:e2e 'home-widgets\.spec\.ts$'` against that
local base URL.
