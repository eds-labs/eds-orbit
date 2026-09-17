import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
process.loadEnvFile(".runtime/local.env");
if (
  process.env.EXECUTION_MODE !== "test" ||
  new URL(process.env.DATABASE_URL!).port !== "55432"
)
  throw new Error("Isolated local test configuration required");
const existing = existsSync(".runtime/e2e-user.json")
  ? JSON.parse(readFileSync(".runtime/e2e-user.json", "utf8"))
  : null;
if (existing?.projectId) {
  console.log("Preserved existing synthetic browser account.");
  process.exit(0);
}
const { buildServer } = await import("../apps/api/src/server.ts");
const { closeDatabase } = await import("../packages/db/src/index.ts");
const app = await buildServer((error) => {
  const e = error as Error;
  let message = e.message;
  for (const value of Object.values(process.env))
    if (value && value.length > 20)
      message = message.replaceAll(value, "[redacted]");
  console.error(e.name, message);
});
const headers = { origin: process.env.APP_ORIGIN! };
const email = existing?.email ?? "orbit-owner@example.invalid",
  password = existing?.password ?? randomBytes(24).toString("base64url");
if (!existing) {
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers,
    payload: {
      name: "Synthetic Orbit Owner",
      email,
      password,
      workspaceName: "Orbit isolated acceptance",
      setupToken: process.env.ORBIT_SETUP_TOKEN,
    },
  });
  if (setup.statusCode === 201)
    writeFileSync(
      ".runtime/e2e-user.json",
      JSON.stringify({ email, password }),
      { mode: 0o600 },
    );
  if (setup.statusCode !== 201)
    throw new Error(
      "Synthetic setup failed: " +
        setup.statusCode +
        " " +
        setup.json().error?.code,
    );
}
const login = await app.inject({
  method: "POST",
  url: "/api/auth/sign-in/email",
  headers,
  payload: { email, password },
});
if (login.statusCode !== 200)
  throw new Error("Synthetic login failed " + login.statusCode);
const cookies = login.headers["set-cookie"];
const cookie = (Array.isArray(cookies) ? cookies : [cookies])
  .filter(Boolean)
  .map((x) => x!.split(";")[0])
  .join("; ");
const project = await app.inject({
  method: "POST",
  url: "/api/projects",
  headers: { ...headers, cookie },
  payload: {
    name: "Orbit acceptance project",
    timezone: "Europe/Berlin",
    language: "en",
  },
});
if (project.statusCode !== 201)
  throw new Error(
    "Synthetic project failed " +
      project.statusCode +
      " " +
      project.json().error?.code,
  );
writeFileSync(
  ".runtime/e2e-user.json",
  JSON.stringify({ email, password, projectId: project.json().id }),
  { mode: 0o600 },
);
await app.close();
await closeDatabase();
console.log(
  "Created isolated synthetic browser account; credentials remain in ignored mode-0600 runtime file.",
);
