// Fails unless the running local stack reports the expected settings center
// stage (ORBIT_SETTINGS_CENTER) to the seeded e2e user, so a browser run
// meant for one stage cannot pass while the stack serves another.
//
//   node scripts/e2e-stage-check.mjs <off|preview|on> [baseUrl]
//
// Signs in with .runtime/e2e-user.json and reads `settingsCenter` from
// /api/me. Prints only the stage, never the credentials or the session.
import { readFileSync } from "node:fs";

const [want, base = "http://localhost:4310"] = process.argv.slice(2);
if (!["off", "preview", "on"].includes(want)) {
  console.error("usage: node scripts/e2e-stage-check.mjs <off|preview|on> [baseUrl]");
  process.exit(2);
}
const { email, password } = JSON.parse(readFileSync(".runtime/e2e-user.json", "utf8"));
// The web server may answer before the API behind it: retry while the
// request cannot reach the API (network error or a 5xx from the proxy).
async function signInOnce() {
  return fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
  });
}
let signIn;
for (let attempt = 1; ; attempt++) {
  signIn = await signInOnce().catch(() => null);
  if ((signIn && signIn.status < 500) || attempt === 30) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!signIn) {
  console.error("The API did not answer");
  process.exit(1);
}
if (!signIn.ok) {
  console.error(`Sign-in of the seeded e2e user failed (${signIn.status})`);
  process.exit(1);
}
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const response = await fetch(`${base}/api/me`, { headers: { cookie } });
if (!response.ok) {
  console.error(`GET /api/me failed (${response.status})`);
  process.exit(1);
}
const stage = (await response.json()).settingsCenter ?? "off";
if (stage !== want) {
  console.error(`The stack reports the settings center stage "${stage}", expected "${want}"`);
  process.exit(1);
}
console.log(`Settings center stage: ${stage}`);
