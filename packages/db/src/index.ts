import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
export { Prisma, PrismaClient };
export type DbTx = Prisma.TransactionClient;
const clients = new Map<string, PrismaClient>();
export function createClient(url: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 10 }),
    log: [],
  });
}
function envClient(key: string): PrismaClient {
  const url = process.env[key];
  if (!url) throw new Error(`${key} is required`);
  let client = clients.get(key);
  if (!client) {
    client = createClient(url);
    clients.set(key, client);
  }
  return client;
}
// Lazy clients keep build/import safe without loading credentials or opening sockets.
export const db = new Proxy({} as PrismaClient, {
  get(_target, key) {
    const c = envClient("DATABASE_URL");
    const v = Reflect.get(c, key);
    return typeof v === "function" ? v.bind(c) : v;
  },
});
export const authDb = new Proxy({} as PrismaClient, {
  get(_target, key) {
    const c = envClient("AUTH_DATABASE_URL");
    const v = Reflect.get(c, key);
    return typeof v === "function" ? v.bind(c) : v;
  },
});
export async function scoped<T>(
  workspaceId: string,
  projectId: string,
  fn: (tx: DbTx) => Promise<T>,
  client: PrismaClient = db,
): Promise<T> {
  if (
    !/^[\da-f-]{36}$/i.test(workspaceId) ||
    !/^[\da-f-]{36}$/i.test(projectId)
  )
    throw new Error("Invalid scope");
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id',${workspaceId},true)`;
      await tx.$executeRaw`SELECT set_config('app.project_id',${projectId},true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":" + projectId},0))`;
      return fn(tx);
    },
    { maxWait: 10000, timeout: 30000 },
  );
}
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}
export async function closeDatabase() {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
}
