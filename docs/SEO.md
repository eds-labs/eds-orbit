# SEO and Google Search Console

Orbit SEO is a project module for organic search performance. Owners register websites and decide which verified provider property each website reports on. Members with SEO read access can view its clicks, impressions, search click-through rate and average position by date, page, query, country or device. Marketing and CMS can be disabled independently.

## Installation and connection

1. In the target Orbit environment, apply the approved migration through the standard release process. The installation needs `ORBIT_SEO=true`, `ORBIT_MODULES=true` for project switching, and `ORBIT_CONNECTIONS=true` for the integration vault. SEO is off by default for the installation and for each project.
2. In Google Cloud, enable the Search Console API and configure a web application OAuth client. Register `<APP_ORIGIN>/api/seo/oauth/callback/google-search-console` as an exact redirect URI. Use a client and eligible test users for the target environment. The requested scope is `https://www.googleapis.com/auth/webmasters.readonly`.
3. In **Administration & settings → Whole system → Integrations**, add **Google Search Console OAuth app** (`seo.app.google-search-console`) to the existing encrypted vault using its Client ID and Client secret fields. Grant the connection to the target organization and project with module `seo` and purpose `seo_oauth`.
4. As a project owner, enable **SEO** in **Administration & settings → Modules**. Open the project's **Google Search Console** integration, connect the Google account, and choose a verified property for each website. Orbit discovers both domain and URL-prefix properties visible to the authorized Google account. Each web project can link multiple websites and multiple Google accounts.
5. Open the project's **SEO** page and choose a website, period and grouping. Search Console dates are in Pacific Time. The module requests finalized web-search data and displays missing rows as an empty result. Google may omit days without data or return only its top grouped rows. Orbit accepts up to 90 calendar days and 100 rows per request.

OAuth state expires after ten minutes. Only the signed-in owner who started the flow can consume it, and the code exchange uses PKCE. Connecting or reconnecting stores the Google refresh token in the module-managed vault account for that project. Disconnecting revokes Orbit's use of that account and clears its active credential. Its website mappings remain visible until the project owner reassigns or removes them. Project-level deactivation blocks the module while preserving setup.

## Permissions and agent use

- `seo.read` follows the project's SEO module role (owner, editor or viewer by default). `seo.manage` is owner-only. A `none` override hides SEO for that member.
- For configured Orbit agents, allow the SEO module on the agent and select the relevant capabilities. Scheduled monitoring can invoke those capabilities through Orbit's existing configured-agent scheduler and policy checks.
- External MCP grants require `orbit:read`, explicit opt-in to `orbit:seo.read`, project selection and current member access. Reconnect a client to add the new permission to an existing grant. Unless a project is already pinned by the gateway, provide its project ID through the usual tool context.
- `seo_websites_list` lists registered websites and their bindings. `seo_search_performance` accepts one website ID, provider, start and end dates, and optional grouping and row limit. Both are read-only. OAuth operations and property writes are reserved for project owners through the signed-in application.
- Search text can contain personal data. Orbit does not store Search Analytics rows as snapshots or include them in project or MCP audit metadata. Configured-agent data policy applies to that content.

## Internal project API

All routes below are relative to `/api/projects/:projectId/seo` and use the normal Orbit session. A foreign project, website or account is unavailable in the current project context.

| Method and path | Permission | Contract |
|---|---|---|
| `GET` at the base path | `seo.read` | Returns active websites with provider bindings, adapter labels, and `canManage`. Account setup details are shown only to owners. |
| `POST /websites` | `seo.manage` | Creates a website from `name` and an HTTP(S) `url`. |
| `DELETE /websites/:websiteId` | `seo.manage` | Archives a site. |
| `POST /providers/:provider/connect` | `seo.manage` | Starts consent and returns `authorizeUrl`. Supply `connectionId` to reconnect an existing account. |
| `DELETE /providers/:provider/connections/:connectionId` | `seo.manage` | Disconnects the account. |
| `GET /providers/:provider/connections/:connectionId/properties` | `seo.manage` | Returns `{properties: [{id, label}]}`. |
| `PUT /websites/:websiteId/properties/:provider` | `seo.manage` | Assigns a discovered property using `connectionId` and `propertyId`. |
| `DELETE /websites/:websiteId/properties/:provider` | `seo.manage` | Removes the provider binding. |
| `GET /websites/:websiteId/performance` | `seo.read` | Query string needs `provider`, `startDate` and `endDate` in YYYY-MM-DD. Optional `dimension` defaults to `date` and `limit` defaults to 100. |

The first provider ID is `google-search-console`. The provider contract and registry allow adding an adapter without changing the tenant data model or tools. The organization entitlement resolver can allow the module and limit active websites per project. Its current default allows unlimited websites.

## Verification and rollout

See the [repository analysis and migration plan](plans/SEO_CORE.md), [MCP guide](MCP_2_0.md), [Google Search Console API authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing), and the [Search Analytics reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query). Local tests use synthetic accounts, properties and provider HTTP responses. A live Google acceptance is a separate verification using an authorized account and OAuth app.
