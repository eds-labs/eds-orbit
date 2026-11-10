# GitHub App "Orbit Issues"

The issue center ([ISSUES.md](../ISSUES.md)) can create a GitHub issue from a confirmed, share-reviewed Orbit issue, or link an existing GitHub issue. It uses its own GitHub App, **Orbit Issues**, held as a platform connection of provider `github_app` (ADR 0014). The knowledge module's GitHub App is separate and unchanged. Spec: [2026-11-05-issues-github-design.md](../superpowers/specs/2026-11-05-issues-github-design.md).

State: slice 1 (WP3.10a) is implemented and tested on a branch. It is not merged, not deployed, and `ORBIT_ISSUES_GITHUB` is off. Nothing below has been done in production.

## 1. Create the GitHub App

In GitHub (the owner's account or organization) under Settings → Developer settings → GitHub Apps → New GitHub App:

- Name: `Orbit Issues`. Homepage URL: the Orbit origin.
- **Webhook: inactive** (clear "Active"). Slice 1 receives no webhooks.
- Repository permissions: **Issues: Read and write**, **Metadata: Read-only**. No other permission, no account or organization permission.
- Where can it be installed: **Only on this account**.
- Create the App, note the **App ID** and the **slug** (the last part of its public URL), then **Generate a private key**. GitHub downloads a `.pem` file.

## 2. Install it on private repositories

Install the App on the account and choose **Only select repositories**. Select private repositories only. Orbit refuses public and archived repositories when the allow-list is saved and again before every write. The **installation id** is the number at the end of the installation settings URL (`.../settings/installations/<id>`).

## 3. Create the connection (administration)

Done by a person with administration access, never by an agent. Administration → Connections → new system connection:

- Provider `github_app`. Base URL: leave the default.
- Secret: **one JSON string**, pasted into the connection's single secret field:

  ```
  {"appId": "...", "appSlug": "...", "installationId": "...", "privateKey": "<contents of the .pem file>"}
  ```

  The field is a single-line password input and drops line breaks. Real line breaks inside a JSON string are invalid JSON anyway, so paste the key either as one line (the field turns the line breaks of a copied `.pem` into spaces; Orbit restores them) or with each line break written as `\n`. Orbit rebuilds the original PEM from both forms. Do not paste the key anywhere else, and never into documentation, chat or tickets.
- Run the connection check. It signs an App JWT and reads the installation (`GET /app/installations/{id}`); it mints no installation token and writes nothing. The installation must belong to the App named by `appSlug` (compared case-insensitively), otherwise the check refuses with `GITHUB_APP_INVALID`: reconcile finds Orbit's issues by their creator `<appSlug>[bot]`, so a wrong slug would hide them. Success gives `read_verified`, capability `github_issues`, and the App slug as the account. Other failures show `GITHUB_RECONNECT_REQUIRED`, `GITHUB_ACCESS_OR_RATE_LIMIT` or `GITHUB_REQUEST_FAILED`.

The secret is sealed with `CREDENTIAL_KEY` and is never logged, returned or shown again.

## 4. Grant it to the project

Grant the connection to the organization and then to the project with purpose **`issues`**. If the grant restricts modules, it must include **`issues`** (a grant without a module restriction serves every module). A project without such an active grant cannot use it (`ISSUES_GITHUB_NOT_CONNECTED`). Revoking the grant stops the next job attempt.

## 5. Switch the flag on

`ORBIT_ISSUES_GITHUB` defaults to `false`. It takes effect only together with `ORBIT_ISSUES=true` and `ORBIT_CONNECTIONS=true`. While it is off, every GitHub route answers 404 `ISSUES_GITHUB_DISABLED` and the worker job refuses. Setting it in Coolify and redeploying is a separate approval; the feature flag default in code does not establish the production state.

## 6. Allow-list and components

In the project's Issues settings, an owner (permissions `issues.settings` and `issues.github`) picks repositories from the installation. Only private, unarchived ones can be chosen; at most 20. Each component may name a default repository (its key). Orbit creates or links only in allow-listed repositories.

## 7. Permissions of each token

Each operation mints a short-lived installation token for exactly the repositories it needs. Tokens are used for one operation and never stored. The App itself holds Issues read/write and Metadata read; a token is never broader than the operation.

| Operation | Token permissions | Repositories |
|---|---|---|
| Create a GitHub issue (the POST and the job's marker lookup before a repeated write) | Issues: write, Metadata: read | the one target repository |
| Repository privacy re-check before every write, link an existing issue, refresh state, reconcile (owner action) | Issues: read, Metadata: read | the one target repository |
| Repository listing for the settings picker | Metadata: read only | the whole installation |
| Connection check | App JWT only (reads the installation) | none |

## 8. Live acceptance (private test repository)

Preview, create, inspect the GitHub body (marker, fields, Orbit link, no customer data), refresh, link an existing issue, unlink. Close the test issue in GitHub manually; Orbit never closes it. Do not infer live acceptance from the automated tests, which use a mock transport.

## Revoke and uninstall

- Rollback of the feature: set `ORBIT_ISSUES_GITHUB=false` and redeploy (routes 404, job refuses).
- Stop Orbit's access: revoke the project grant, or delete the connection in the administration.
- Remove GitHub's side: uninstall the App from the repositories or the account (GitHub → Settings → Applications → Installed GitHub Apps), and delete the private key in the App settings. After a suspected leak, delete the key first, generate a new one and update the connection secret.
- Existing links stay as plain links on Orbit issues; no data needs undoing. Unlinking removes only the Orbit side.

## Troubleshooting

- `ISSUES_GITHUB_NOT_CONNECTED`: no active grant with purpose `issues`, or the connection is not usable.
- `GITHUB_APP_INVALID`: the secret JSON is incomplete, the key cannot be read, or the installation belongs to another App than `appSlug`. Re-enter the whole JSON.
- `GITHUB_RECONNECT_REQUIRED`: GitHub rejected the App (wrong key, App suspended, or uninstalled).
- `GITHUB_ACCESS_OR_RATE_LIMIT`: the installation lacks access to the repository, or a rate limit applies; retry later.
- `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`: not in the allow-list, not in the installation, or archived.
- `ISSUES_GITHUB_REPOSITORY_PUBLIC`: the repository is public; Orbit writes to private repositories only.
- Other codes: see [ISSUES.md](../ISSUES.md#github).
