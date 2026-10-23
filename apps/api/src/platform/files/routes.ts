import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_READ,
  PROJECT_WRITE,
} from "../tenancy/permissions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { DomainError } from "../shared.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { deleteFile, fileRow, readFile, storeFile } from "./files.ts";

// Platform file routes (WP4.6). A file belongs to one module: uploading
// and deleting need write access there, downloading read access, and the
// module must be on. The platform's own files (raw inbound e-mail) are the
// owner's only, and no member uploads into them. Every route answers 404
// while files are off or not configured (the server's onRequest hook says
// so before parsing).

export const FILE_ROUTE_PREFIX = "/api/projects/:projectId/files";
const moduleId = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/);

/** The member's scope in the file's module, with the permission checked. */
async function inModule(
  scope: Scope,
  module: string,
  required: PermissionDef,
): Promise<Scope> {
  const effective = moduleScope(scope, module);
  authorize(effective, required);
  // Platform files hold the mailbox, which only the owner sees (WP4.7).
  if (module === "platform") authorize(effective, PROJECT_OWN);
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    assertModuleEnabled(tx, effective, module),
  );
  return effective;
}

/** The module of a live file of the project, or 404. */
const moduleOf = (scope: Scope, id: string) =>
  scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => (await fileRow(tx, scope, id)).moduleId,
  );

/** RFC 5987 `attr-char` encoding for `filename*`. */
const extValue = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * A Content-Disposition value whose plain `filename` is printable ASCII and
 * whose `filename*` carries the full name (RFC 6266, RFC 5987).
 */
export const contentDisposition = (
  disposition: "attachment" | "inline",
  name: string,
) =>
  `${disposition}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${extValue(name)}`;

const uploadScope = new WeakMap<object, Scope>();

export async function registerFileRoutes(app: FastifyInstance, auth: Auth) {
  await app.register(async (child) => {
    // The body arrives as raw bytes; Fastify counts it while it streams in
    // and stops with 413 at the configured limit.
    child.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: loadConfig().FILES_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      FILE_ROUTE_PREFIX,
      {
        bodyLimit: loadConfig().FILES_MAX_BYTES,
        // Session, module, write access and content type are checked before
        // a byte of the body is read: no stranger makes the API buffer up
        // to FILES_MAX_BYTES, and no other parser runs under that limit.
        onRequest: async (req) => {
          const { projectId } = req.params as { projectId: string };
          // The session first: nothing is validated for a stranger.
          const member = await scopeFor(auth, req, projectId);
          const query = z.object({ module: moduleId }).parse(req.query ?? {});
          // The platform writes its own files; members never do.
          if (query.module === "platform")
            throw new DomainError("MODULE_UNKNOWN", 409);
          const scope = await inModule(member, query.module, PROJECT_WRITE);
          const type = (req.headers["content-type"] ?? "")
            .split(";")[0]!
            .trim()
            .toLowerCase();
          if (type !== "application/octet-stream")
            throw new DomainError("FILE_BODY_REQUIRED", 415);
          uploadScope.set(req, scope);
        },
      },
      async (req, reply) => {
        const query = z.object({ module: moduleId }).parse(req.query ?? {});
        const scope = uploadScope.get(req);
        if (!scope || !Buffer.isBuffer(req.body))
          throw new DomainError("FILE_BODY_REQUIRED", 415);
        const name = req.headers["x-file-name"];
        const stored = await storeFile(scope, {
          moduleId: query.module,
          bytes: req.body,
          mime: String(req.headers["x-file-type"] ?? ""),
          name:
            typeof name === "string"
              ? (() => {
                  try {
                    return decodeURIComponent(name);
                  } catch {
                    return null;
                  }
                })()
              : null,
        });
        return reply.code(201).send(stored);
      },
    );
    child.get(`${FILE_ROUTE_PREFIX}/:fileId`, async (req, reply) => {
      const { projectId, fileId } = req.params as {
        projectId: string;
        fileId: string;
      };
      const id = z.uuid().parse(fileId);
      const member = await scopeFor(auth, req, projectId);
      const scope = await inModule(
        member,
        await moduleOf(member, id),
        PROJECT_READ,
      );
      const { file, bytes } = await readFile(scope, id);
      return reply
        .header("Content-Type", file.mime)
        .header("Content-Length", String(bytes.byteLength))
        .header(
          "Content-Disposition",
          contentDisposition("attachment", file.name ?? "file"),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(Buffer.from(bytes));
    });
    child.delete(`${FILE_ROUTE_PREFIX}/:fileId`, async (req) => {
      const { projectId, fileId } = req.params as {
        projectId: string;
        fileId: string;
      };
      const id = z.uuid().parse(fileId);
      const member = await scopeFor(auth, req, projectId);
      const scope = await inModule(
        member,
        await moduleOf(member, id),
        PROJECT_WRITE,
      );
      return deleteFile(scope, id);
    });
  });
}
