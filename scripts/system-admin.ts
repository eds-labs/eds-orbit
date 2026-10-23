/**
 * Grants, revokes or lists system administrators (ADR 0013). The recovery
 * and bootstrap path for an existing installation; run it inside the api
 * container, never from a web request:
 *
 *   tsx scripts/system-admin.ts list
 *   tsx scripts/system-admin.ts grant --email person@example.com
 *   tsx scripts/system-admin.ts revoke --email person@example.com
 *
 * Changes are audited as `system:cli`. The last active administrator cannot
 * be revoked. Prints ids and addresses of administrators only.
 */
import { authDb, closeDatabase } from "../packages/db/src/index.ts";
import { setSystemRoleByEmail } from "../apps/api/src/platform/administration/users.ts";

const [command, flag, email] = process.argv.slice(2);
try {
  if (command === "list") {
    const admins = await authDb.user.findMany({
      where: { role: "admin" },
      select: { id: true, email: true, banned: true },
      orderBy: { createdAt: "asc" },
    });
    for (const a of admins)
      console.log(`${a.id}  ${a.email}${a.banned ? "  (deactivated)" : ""}`);
    if (!admins.length) console.log("No system administrator.");
  } else if (
    (command === "grant" || command === "revoke") &&
    flag === "--email" &&
    email
  ) {
    const result = await setSystemRoleByEmail(
      email,
      command === "grant" ? "admin" : "user",
    );
    console.log(
      result.changed
        ? `${command === "grant" ? "Granted" : "Revoked"} for ${result.userId}.`
        : `Unchanged for ${result.userId}.`,
    );
  } else {
    console.error(
      "Usage: system-admin.ts list | grant --email <address> | revoke --email <address>",
    );
    process.exitCode = 2;
  }
} catch (error) {
  // Codes only: no driver details or connection strings.
  const code = (error as { code?: string })?.code;
  console.error(`Failed: ${typeof code === "string" ? code : "UNKNOWN"}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
