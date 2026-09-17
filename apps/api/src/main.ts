import { buildServer } from "./server.ts";
import { closeDatabase } from "../../../packages/db/src/index.ts";
const app = await buildServer();
await app.listen({
  port: Number(process.env.PORT ?? 4311),
  host: process.env.BIND_HOST ?? "127.0.0.1",
});
console.log("Orbit API listening on configured interface");
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, async () => {
    await app.close();
    await closeDatabase();
    process.exit(0);
  });
