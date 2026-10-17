# Platform files

Modules store binary files (support attachments, raw e-mail) through the platform's file service (WP4.6). Content lives encrypted in its own S3-compatible bucket; Orbit's `File` table holds the metadata under row-level security. Marketing's brand assets are unchanged and stay in `Entity` data.

Files are off unless `ORBIT_FILES=true` **and** the bucket is configured. Otherwise every file route answers 404 and the service refuses with `FILES_NOT_CONFIGURED`.

## Setting up the bucket (Mario)

Approved 2026-10-17 (Q-19): a separate Cloudflare R2 bucket next to the backup bucket. Never reuse the backup bucket or its token.

1. **Create the bucket.** Cloudflare → R2 → Create bucket.
   - Name: for example `orbit-files`.
   - Location: EU jurisdiction if offered.
   - No public access, no custom domain.
2. **Create a token.** R2 → Manage API tokens → Create API token.
   - Permission: _Object Read & Write_.
   - Scope: _this bucket only_.
   - Note the Access Key ID and the Secret Access Key. Cloudflare shows the secret only once.
3. **Create the encryption key** locally:

   ```bash
   openssl rand -hex 32
   ```

   Keep it in the password manager. Without it, stored files cannot be read.

4. **Set the variables in Coolify** (Orbit → Environment Variables):
   - `FILES_S3_ENDPOINT` = `https://<account-id>.r2.cloudflarestorage.com`
   - `FILES_S3_BUCKET` = the bucket name
   - `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` = the token
   - `FILES_ENCRYPTION_KEY` = the key from step 3
   - `ORBIT_FILES` stays `false` until the security review is done and the flag is approved.

The api and worker containers receive these variables; the backup container does not, and the compose check enforces that.

## How it works

- **Encryption.** Each file is encrypted with AES-256-GCM before upload, using a fresh IV and the file id as additional data. A download checks the tag and the SHA-256 before anything is sent. R2's own at-rest encryption comes on top.
- **Object keys.** `projects/<projectId>/<moduleId>/<fileId>`: no name, no content, no user.
- **Routes:**

  | Route                                      | Needs                                                                                                                           |
  | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /api/projects/:id/files?module=<id>` | write access in the module; the body is the raw bytes (`application/octet-stream`) with headers `x-file-type` and `x-file-name` |
  | `GET /api/projects/:id/files/:fileId`      | read access in the file's module; sent as an attachment with `nosniff` and a sandboxing CSP                                     |
  | `DELETE /api/projects/:id/files/:fileId`   | write access in the file's module                                                                                               |

  A switched-off module's files answer 404 `MODULE_DISABLED`. The platform's own files (module `platform`, such as raw inbound e-mail) are the owner's only, and no member uploads into them.

  The upload checks the session, module, write access and content type before it reads the body. A file's name loses paths, control and bidi characters and ends in an extension of its type (plain text named `run.bat` is stored as `run.bat.txt`).

- **Limits.**
  - Size: `FILES_MAX_BYTES`, default 20 MB, at most 50 MB.
  - Types:
    - images (PNG, JPEG, GIF, WebP) and PDF, each checked by its file signature;
    - plain text, CSV and `message/rfc822`.
- **Deleting.** A deleted file is unreadable at once. The object and the row follow right away. If the bucket fails, the hourly `file-cleanup` task retries.

## Limits and follow-ups

- Deleting a whole project removes its rows (cascade) but not its objects. No product path deletes projects yet; one that does must purge the project's files first. A purge of the project's key prefix is a follow-up.
- There is no virus scanning. Downloads are always attachments, never rendered inline.
- Key rotation for `FILES_ENCRYPTION_KEY` is not supported yet; changing it makes existing files unreadable.
