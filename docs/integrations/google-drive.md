# Google Drive asset storage

Orbit uses a project-scoped Google Drive connection. It stores connection, OAuth state, storage settings and asset metadata in the existing `Entity`/`EntityVersion` tables under the existing project RLS policies, so no schema migration is required. The API keeps the OAuth refresh token encrypted with `CREDENTIAL_KEY`; the browser and agents never receive it. Existing Drive files are listed on demand. Imported files keep metadata in Orbit and remain private in Google Drive. Generated images retain a local fallback copy in the existing asset record so that a failed upload does not lose the result.

## Google Cloud setup

1. In Google Cloud, enable the Google Drive API and configure the OAuth consent screen for the intended users.
2. Create a **Web application** OAuth client. Add the exact redirect URI `https://<orbit-origin>/api/google-drive/callback` (for local development, use the configured `APP_ORIGIN` instead of the production origin).
3. Configure the consent screen with `https://www.googleapis.com/auth/drive`. This is a **restricted** scope and can require Google verification. Do not deploy it to general users before the required Google review is complete.
4. Set `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` on the Orbit API and worker hosts. Keep `CREDENTIAL_KEY` stable and secret; changing it without re-encrypting stored credentials invalidates connections. No real value belongs in `.env.example` or version control.
5. In Settings → Integrations · Google Drive, connect the account, then save the project root folder ID and optional brand folders. Disconnect deletes the encrypted token and disables storage without deleting Drive files or Orbit asset records. Reconnect to resume access.

## Scope decision

Google recommends `drive.file` for files that users explicitly open with an app or share through Google Picker. Orbit currently browses a pre-existing directory tree, indexes existing assets and creates generated subfolders under an existing folder. `drive.file` alone does not guarantee access to all existing descendants or permission to create under an arbitrary existing folder. The current integration therefore requests the full Drive scope. This permits more access than Orbit uses. Root ancestry checks restrict every Orbit browse, preview, import and upload to the configured project root, but they do **not** reduce the underlying Google grant. A future Google Picker flow plus per-file sharing should be evaluated to narrow the scope. See [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [OAuth server-side flow](https://developers.google.com/identity/protocols/oauth2/web-server).

## Project folders

Folder IDs are configuration, never code constants. For the uLiquid project, the user can select:

| Purpose        | Drive folder ID                     |
| -------------- | ----------------------------------- |
| Root `uLiquid` | `1U-p6wcr-Hm-tQ-oCiPz8GL-kGUaLTN5f` |
| Brand logos    | `1muG7hR2IxjZHhjanVNEjlzYszQB4TDLD` |
| Brand images   | `1mDCDkok9WXmyyLMs8LOGnJqBMAUEmW-7` |

Orbit locates `04_Website_und_Marketing` directly below the selected root. It creates `Orbit_Generated` and a category folder on first upload, reusing existing folders by name. Social assets with a selected platform are placed in `Social/X`, `Social/Telegram`, `Social/LinkedIn`, `Social/Instagram` or `Social/Facebook`. Created folder IDs are retained in the project storage record. If the marketing folder does not exist, `Orbit_Generated` is created below the root. It does not share folders publicly. Existing file metadata is fetched only when browsing or adding the file to the library. Owners can also upload PNG, JPEG and WebP through the Drive browser; Orbit validates and strips metadata, preserving WebP output for WebP input. Imported and uploaded assets stay unapproved references until rights review. A manual **Sync from Drive** button reloads the current folder.

## Asset workflow

A project owner connects and configures Drive. The existing template renderer can load an approved Drive PNG, JPEG or WEBP logo and refuse changed Drive versions before creating a graphic; SVG remains browsable but is not accepted as a template image input. Members can browse and preview project-root files; only owners can register them in the Orbit library. Registration creates an unapproved reference asset. Brand logos and images are exposed as a project-scoped read service, but the owner still must approve usage through Orbit's existing rights flow. Agent code must call the internal asset API; it must not receive Google credentials.

The existing OpenAI image flow records the normalized PNG in an Orbit asset first. Unless the owner unchecks **Save generated image to Google Drive**, Orbit uploads to the configured Drive project root and records the Drive file ID, folder ID, link and sync state. Upload failure retains the local result, marks `FAILED` and schedules up to five bounded worker retries with exponential backoff. The owner can retry manually. Drive file creation uses an `orbitAssetId` app property for duplicate detection after a partial failure. The image remains an unapproved reference until the normal brand and rights review.

## Local development and verification

`GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` are optional until a connection is attempted. Use a dedicated Google test account and an isolated test root. `APP_ORIGIN` must match the OAuth redirect origin exactly. Run `pnpm typecheck`, `pnpm lint`, and `pnpm exec vitest run apps/api/src/modules/google-drive.test.ts apps/api/src/modules/google-drive.mock.test.ts`. A real acceptance run additionally needs a reachable local database, a Google OAuth client/test user, Drive access to the chosen root, and an explicitly approved paid image generation test. Verify OAuth connect, refresh, root selection, existing logo preview, generation, Drive upload, re-read and disconnect/reconnect with that environment. Do not infer live acceptance from typechecks or mocks.

## Production and rollback

Before production setup, back up the Orbit database, verify restore, provision the OAuth client/redirect URI and secret values through the deployment secret store, and complete Google scope review. Monitor OAuth refresh failures, `FAILED` Drive sync states, retry exhaustion and Drive API quota errors. Rollback is to disable Google Drive storage for the project and revert the application version; existing Drive files and Orbit asset records remain. Do not delete Drive files during rollback. Disconnect only removes the refresh token.

## Troubleshooting

- `GOOGLE_DRIVE_NOT_CONFIGURED`: set both OAuth client variables on the server.
- `GOOGLE_DRIVE_OAUTH_STATE_INVALID`: restart connect; the ten-minute state expired, was used, or belongs to another session/project.
- `GOOGLE_DRIVE_RECONNECT_REQUIRED`: reconnect the Google account; its refresh grant may have been revoked.
- `GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT`: choose a folder inside the configured project root.
- `GOOGLE_DRIVE_REQUEST_FAILED`: inspect Google consent, API enablement, folder permission and quota without logging credentials.
- `FAILED` on a generated asset: use Retry Drive upload after checking the connection; the local result is retained.
