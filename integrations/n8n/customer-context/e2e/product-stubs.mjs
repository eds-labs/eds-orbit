// Local product stand-ins for the end-to-end test (Orbit → n8n → product).
// Test-only tokens, synthetic customers, loopback only.
//
// - uLiquid Desk: `GET /integrations/v1/customers/:id/context` with Desk's
//   bearer check and error bodies; answers are the fixtures generated with
//   Desk's own context builder (fixtures/desk).
// - FamilyPlan: `POST /functions/v1/support-customer-context`. With
//   FAMILYPLAN_HANDLER pointing at the FamilyPlan repository's
//   `supabase/functions/support-customer-context/handler.ts`, the real
//   handler answers from in-memory billing snapshots; otherwise the fixtures.
//
// Special ids: `ckdesk0004slow` answers after 3.5 s (beyond n8n's 2.5 s
// product budget); `ckdesk0005broken` and `familyplan:…a09` drop the
// connection (product unreachable).
//
//   node integrations/n8n/customer-context/e2e/product-stubs.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const E2E = {
  deskPort: Number(process.env.DESK_STUB_PORT || 5801),
  familyPlanPort: Number(process.env.FAMILYPLAN_STUB_PORT || 5802),
  deskToken: "dctx_e2e_test_only_token_not_for_production_0001",
  familyPlanToken: "fpctx_e2e_test_only_token_not_for_production_0001",
};
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const fixture = (dir, name) => JSON.parse(readFileSync(join(fixtures, dir, name), "utf8"));
const FP = "familyplan:5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a0";

/** Every product call the stubs received: `{ product, id }`, for "no call" checks. */
export const stubRequests = [];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const desk = {
  ckdesk0001active: "desk-active.json",
  ckdesk0002nocred: "desk-credits-exhausted.json",
  ckdesk0003denied: "desk-feature-denied.json",
};

export function deskStub() {
  return createServer(async (req, res) => {
    const match = /^\/integrations\/v1\/customers\/([^/]+)\/context$/.exec(req.url || "");
    if (req.method !== "GET" || !match) return send(res, 404, { error: "not_found" });
    if (req.headers.authorization !== `Bearer ${E2E.deskToken}`) return send(res, 401, { error: "unauthorized" });
    const id = decodeURIComponent(match[1]);
    stubRequests.push({ product: "uliquid-desk", id });
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, 400, { error: "invalid_customer_id" });
    if (id === "ckdesk0005broken") return req.socket.destroy();
    if (id === "ckdesk0004slow") {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const body = fixture("desk", desk.ckdesk0001active);
      body.customer.externalUserId = id;
      return send(res, 200, body);
    }
    if (!desk[id]) return send(res, 404, { error: "customer_not_found" });
    send(res, 200, fixture("desk", desk[id]));
  });
}

// Billing state as FamilyPlan's tables hold it (seed data of the migrations).
const FEATURES = ["dashboard", "today", "calendar", "tasks", "lists", "chat", "meals", "recipes", "school", "rewards", "budget", "locations"];
const TITLES = ["Dashboard", "Heute", "Kalender", "Aufgaben", "Listen", "Chat", "Essen", "Rezepte", "Schule", "Punkte", "Budget", "Standorte"];
function snapshots() {
  const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const base = {
    bannedUntil: null,
    plans: [
      { key: "free", title: "Free", is_active: true },
      { key: "family_premium", title: "FamilyPlan Premium", is_active: true },
    ],
    features: FEATURES.map((key, i) => ({ key, title: TITLES[i], sort_order: i * 10, is_active: true })),
    planFeatures: [
      ...FEATURES.slice(0, 5).map((key) => ({ plan_key: "free", feature_key: key })),
      ...FEATURES.map((key) => ({ plan_key: "family_premium", feature_key: key })),
    ],
  };
  const row = (family, over) => ({
    family_id: family, source: "apple", status: "active", plan_key: "family_premium",
    expires_at: inDays(30), revoked_at: null, updated_at: inDays(-1), ...over,
  });
  return {
    // Active Premium (Apple).
    "5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a01": { ...base, familyIds: ["f-1"], entitlements: [row("f-1", {})] },
    // Premium expired a week ago: no valid Premium.
    "5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a02": {
      ...base, familyIds: ["f-2"], entitlements: [row("f-2", { status: "expired", expires_at: inDays(-7) })],
    },
    // Two families, one with a manual Premium grant.
    "5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a03": {
      ...base, familyIds: ["f-3", "f-4"], entitlements: [row("f-3", { source: "manual", status: "manual", expires_at: null })],
    },
  };
}

export async function familyPlanStub() {
  const path = process.env.FAMILYPLAN_HANDLER;
  let handle = null;
  if (path) {
    const { customerContextHandler } = await import(pathToFileURL(path).href);
    const data = snapshots();
    handle = customerContextHandler({
      env: (key) =>
        key === "SUPPORT_CUSTOMER_CONTEXT_TOKEN_SHA256"
          ? createHash("sha256").update(E2E.familyPlanToken).digest("hex")
          : undefined,
      load: async (userId) => data[userId] ?? null,
    });
  }
  const fixturesById = {
    [`${FP}1`]: "familyplan-premium.json",
    [`${FP}2`]: "familyplan-no-premium.json",
    [`${FP}3`]: "familyplan-multiple-families.json",
  };
  return createServer(async (req, res) => {
    if (req.url !== "/functions/v1/support-customer-context") return send(res, 404, { error: "NOT_FOUND" });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let id = null;
    try {
      id = JSON.parse(raw).externalUserId;
    } catch {}
    stubRequests.push({ product: "familyplan", id });
    if (id === `${FP}9`) return req.socket.destroy();
    if (handle) {
      const response = await handle(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
          body: req.method === "POST" ? raw : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    if (req.headers["x-customer-context-token"] !== E2E.familyPlanToken) return send(res, 401, { error: "UNAUTHORIZED" });
    if (typeof id !== "string" || !/^familyplan:[0-9a-f-]{36}$/.test(id)) return send(res, 400, { error: "INVALID_REQUEST" });
    if (!fixturesById[id]) return send(res, 404, { error: "CUSTOMER_NOT_FOUND" });
    const body = fixture("familyplan", fixturesById[id]);
    body.generatedAt = new Date().toISOString();
    send(res, 200, body);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deskStub().listen(E2E.deskPort, "127.0.0.1");
  (await familyPlanStub()).listen(E2E.familyPlanPort, "127.0.0.1");
  console.log(
    `Desk stub :${E2E.deskPort}, FamilyPlan stub :${E2E.familyPlanPort} (${process.env.FAMILYPLAN_HANDLER ? "real handler" : "fixtures"})`,
  );
}
