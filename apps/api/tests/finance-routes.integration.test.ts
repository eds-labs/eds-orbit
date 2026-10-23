import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import { CONNECTION_KIND } from "../src/platform/connections/connections.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { ingestDocument } from "../src/modules/finance/intake/documents.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const MAX_BYTES = 64 * 1024;
const ENV = {
  ORBIT_FINANCE: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  FILES_MAX_BYTES: String(MAX_BYTES),
};
const pdf = () =>
  Buffer.concat([
    readFileSync(new URL("./fixtures/finance/invoice.pdf", import.meta.url)),
    Buffer.from(`%${randomUUID()}\n`),
  ]);
const xml = () =>
  Buffer.from(`<?xml version="1.0"?><Invoice id="${randomUUID()}"/>`);

/**
 * The finance HTTP API (spec §8): permissions per role, the finance gate,
 * project isolation, the upload limit, safe downloads and bigint micros as
 * decimal strings. Three members sign in (the Better Auth sign-in limit);
 * the second project is only reached through the owner's id.
 */
describe.skipIf(!enabled)("finance http api", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const previous: Record<string, string | undefined> = {};
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/finance${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const upload = (
    who: keyof typeof ids,
    bytes: Buffer,
    type: string,
    name = "original.pdf",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/finance/documents`,
      headers: {
        origin,
        cookie: cookies[who],
        [CLIENT_IP_HEADER]: ip(),
        "content-type": "application/octet-stream",
        "x-file-type": type,
        "x-file-name": encodeURIComponent(name),
      },
      payload: bytes,
    });
  const ownerScope = (project = projectId): Scope => ({
    workspaceId,
    projectId: project,
    userId: ids.owner,
    role: "owner",
  });
  const error = (response: { json(): any }) => response.json().error?.code;

  let counterpartyId = "";
  let categoryId = "";
  let connectionId = "";
  const booking = () => ({
    kind: "invoice",
    direction: "payable",
    counterpartyId,
    number: `INV-${randomUUID().slice(0, 8)}`,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    currency: "USD",
    lines: [
      {
        description: "Service",
        amount: "100.00",
        tax: "19.00",
        categoryId,
        allocation: [],
      },
    ],
  });
  /** Uploads a PDF as `who` and books it; returns the booking result. */
  const uploadAndBook = async (who: keyof typeof ids) => {
    const uploaded = await upload(who, pdf(), "application/pdf");
    expect(uploaded.statusCode).toBe(201);
    const { id } = uploaded.json();
    const { version } = (await call(who, "GET", `/documents/${id}`)).json();
    const booked = await call(who, "POST", `/documents/${id}/book`, {
      version,
      booking: booking(),
    });
    expect(booked.statusCode).toBe(200);
    return { documentId: id as string, ...booked.json() };
  };

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic finance ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic finance api",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    projectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic finance api" },
      })
    ).id;
    // A second project of the same owner; finance is never enabled there.
    otherProjectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic finance other" },
      })
    ).id;
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId: ids[who], role },
      });
    await scoped(workspaceId, projectId, async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId,
          projectId,
          moduleId: "finance",
          enabled: true,
          moduleVersion: "1.0.0",
          settings: {},
        },
      });
      connectionId = (
        await create(tx, ownerScope(), CONNECTION_KIND, {
          provider: "email",
          fromAddress: `${randomUUID()}@example.invalid`,
        })
      ).id;
    });
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
    // The starting chart of accounts, a counterparty and a category.
    expect((await call("owner", "GET", "/setup")).json()).toMatchObject({
      ready: false,
    });
    expect((await call("owner", "POST", "/setup")).statusCode).toBe(200);
    expect((await call("owner", "GET", "/setup")).json()).toEqual({
      ready: true,
      missingRoles: [],
    });
    const categories = (await call("owner", "GET", "/categories")).json();
    categoryId = categories.items.find(
      (c: { name: string }) => c.name === "Software & SaaS",
    ).id;
    const counterparty = await call("editor", "POST", "/counterparties", {
      name: "Acme GmbH",
    });
    expect(counterparty.statusCode).toBe(200);
    counterpartyId = counterparty.json().id;
  });
  afterEach(() => {
    process.env.ORBIT_FINANCE = "true";
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("viewer gets 403 on finance reads by default", async () => {
    for (const url of [
      "/summary?from=2026-01-01&to=2026-12-31",
      "/documents",
      "/entries",
      "/invoices",
      "/settings",
      "/setup",
      "/categories",
    ]) {
      const response = await call("viewer", "GET", url);
      expect({
        url,
        status: response.statusCode,
        code: error(response),
      }).toEqual({ url, status: 403, code: "FORBIDDEN" });
    }
    const uploaded = await upload("viewer", pdf(), "application/pdf");
    expect(uploaded.statusCode).toBe(403);
    // The editor reads.
    const summary = await call(
      "editor",
      "GET",
      "/summary?from=2026-01-01&to=2026-12-31",
    );
    expect(summary.statusCode).toBe(200);
  });

  it("editor can book but not change mailboxes", async () => {
    const result = await uploadAndBook("editor");
    expect(result.invoiceId).toEqual(expect.any(String));
    expect(result.entryId).toEqual(expect.any(String));

    for (const [method, url, payload] of [
      ["GET", "/mailboxes", undefined],
      ["POST", "/mailboxes", { emailConnectionId: connectionId }],
      ["DELETE", `/mailboxes/${randomUUID()}`, undefined],
      ["PUT", "/settings", { settings: { aiExtraction: "on" }, version: 1 }],
      ["POST", "/setup", undefined],
      ["POST", "/accounts", { code: "1300", name: "Cash", type: "asset" }],
      [
        "POST",
        "/fx-rates",
        { date: "2026-10-01", currency: "USD", perEur: "1.10" },
      ],
    ] as const) {
      const response = await call("editor", method, url, payload);
      expect({ url, method, status: response.statusCode }).toEqual({
        url,
        method,
        status: 403,
      });
    }

    const bound = await call("owner", "POST", "/mailboxes", {
      emailConnectionId: connectionId,
    });
    expect(bound.statusCode).toBe(200);
    const list = (await call("owner", "GET", "/mailboxes")).json();
    expect(list.items).toEqual([
      expect.objectContaining({
        id: bound.json().id,
        emailConnectionId: connectionId,
        lastArchiveError: null,
      }),
    ]);
    const unbound = await call(
      "owner",
      "DELETE",
      `/mailboxes/${bound.json().id}`,
    );
    expect(unbound.statusCode).toBe(200);
  });

  it("module off returns 404 FINANCE_DISABLED", async () => {
    process.env.ORBIT_FINANCE = "false";
    for (const response of [
      await call("owner", "GET", "/summary?from=2026-01-01&to=2026-12-31"),
      await call("owner", "GET", "/documents"),
      await call("owner", "POST", "/setup"),
      await upload("owner", pdf(), "application/pdf"),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(error(response)).toBe("FINANCE_DISABLED");
    }
    process.env.ORBIT_FINANCE = "true";
    // A project without the explicit module row stays off.
    const other = await app.inject({
      method: "GET",
      url: `/api/projects/${otherProjectId}/finance/documents`,
      headers: { origin, cookie: cookies.owner, [CLIENT_IP_HEADER]: ip() },
    });
    expect(other.statusCode).toBe(404);
    expect(error(other)).toBe("FINANCE_DISABLED");
  });

  it("other project's document id returns 404", async () => {
    // Recorded straight through the service in the other project.
    const foreign = await ingestDocument(ownerScope(otherProjectId), {
      source: "upload",
      bytes: pdf(),
      mime: "application/pdf",
    });
    for (const [method, url, payload] of [
      ["GET", `/documents/${foreign.id}`, undefined],
      ["GET", `/documents/${foreign.id}/file`, undefined],
      ["PATCH", `/documents/${foreign.id}`, { version: 1, number: "X-1" }],
      ["POST", `/documents/${foreign.id}/reject`, { version: 1, reason: "No" }],
      ["POST", `/documents/${foreign.id}/retry`, undefined],
    ] as const) {
      const response = await call("owner", method, url, payload);
      expect({
        url,
        method,
        status: response.statusCode,
        code: error(response),
      }).toEqual({
        url,
        method,
        status: 404,
        code: "FINANCE_DOCUMENT_NOT_FOUND",
      });
    }
    // The foreign document is untouched.
    const row = await scoped(workspaceId, otherProjectId, (tx) =>
      tx.financeDocument.findUniqueOrThrow({ where: { id: foreign.id } }),
    );
    expect(row.status).toBe("needs_review");
    expect(row.version).toBe(1);
  });

  it("inline disposition refused for xml", async () => {
    const uploaded = await upload("editor", xml(), "application/xml", "e.xml");
    expect(uploaded.statusCode).toBe(201);
    const { id } = uploaded.json();
    const inline = await call(
      "editor",
      "GET",
      `/documents/${id}/file?disposition=inline`,
    );
    expect(inline.statusCode).toBe(415);
    expect(error(inline)).toBe("FINANCE_INLINE_NOT_ALLOWED");
    const attachment = await call("editor", "GET", `/documents/${id}/file`);
    expect(attachment.statusCode).toBe(200);
    expect(attachment.headers).toMatchObject({
      "content-type": "application/xml",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(attachment.headers["content-security-policy"]).toContain("sandbox");
    expect(attachment.headers["content-disposition"]).toMatch(
      /^attachment; filename="e\.xml"/,
    );
    // A PDF may be shown inline, under the same headers.
    const original = pdf();
    const pdfDoc = await upload("editor", original, "application/pdf");
    const shown = await call(
      "editor",
      "GET",
      `/documents/${pdfDoc.json().id}/file?disposition=inline`,
    );
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["content-disposition"]).toMatch(/^inline; /);
    expect(shown.headers["content-security-policy"]).toContain("sandbox");
    expect(shown.rawPayload.equals(original)).toBe(true);
  });

  it("finance files are private to finance's own routes", async () => {
    const uploaded = await upload("editor", pdf(), "application/pdf");
    expect(uploaded.statusCode).toBe(201);
    const { id } = uploaded.json();
    const { fileId } = await scoped(workspaceId, projectId, (tx) =>
      tx.financeDocument.findUniqueOrThrow({ where: { id } }),
    );
    const platform = (who: keyof typeof ids, method: "GET" | "DELETE") =>
      app.inject({
        method,
        url: `/api/projects/${projectId}/files/${fileId}`,
        headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      });
    for (const who of ["owner", "editor"] as const)
      for (const method of ["GET", "DELETE"] as const) {
        const response = await platform(who, method);
        expect(response.statusCode, `${who} ${method}`).toBe(404);
      }
    // Nor does the platform upload into finance.
    const into = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files?module=finance`,
      headers: {
        origin,
        cookie: cookies.owner,
        [CLIENT_IP_HEADER]: ip(),
        "content-type": "application/octet-stream",
        "x-file-type": "application/pdf",
      },
      payload: pdf(),
    });
    expect(into.statusCode).toBe(404);
    // The file is still there for finance's own download route.
    const own = await call("owner", "GET", `/documents/${id}/file`);
    expect(own.statusCode).toBe(200);
  });

  it("upload over the size limit returns 413", async () => {
    const response = await upload(
      "editor",
      Buffer.alloc(MAX_BYTES + 1, 0x25),
      "application/pdf",
    );
    expect(response.statusCode).toBe(413);
    // A JSON body is not an upload.
    const json = await call("editor", "POST", "/documents", { bytes: "x" });
    expect(json.statusCode).toBe(415);
  });

  it("bigint amounts serialize as strings", async () => {
    const { invoiceId, entryId } = await uploadAndBook("editor");
    const invoices = (await call("editor", "GET", "/invoices")).json();
    const invoice = invoices.items.find(
      (i: { id: string }) => i.id === invoiceId,
    );
    expect(invoice).toMatchObject({
      currency: "USD",
      netMicros: "100000000",
      taxMicros: "19000000",
      totalMicros: "119000000",
      openAmountMicros: "119000000",
    });
    const entry = (await call("editor", "GET", `/entries/${entryId}`)).json();
    expect(entry.lines.length).toBeGreaterThan(1);
    for (const line of entry.lines) {
      expect(line.amountMicros).toMatch(/^\d+$/);
      expect(line.baseAmountMicros).toMatch(/^\d+$/);
      expect(typeof line.fxRate).toBe("string");
      expect(line.currency).toBe("USD");
    }
    // Micros go back in as strings too: a full payment settles the invoice.
    const bank = (await call("owner", "GET", "/accounts"))
      .json()
      .items.find((a: { code: string }) => a.code === "1000").id;
    const paid = await call("editor", "POST", "/payments", {
      direction: "outgoing",
      accountId: bank,
      date: "2026-10-05",
      currency: "USD",
      amountMicros: "119000000",
      allocations: [{ invoiceId, amountMicros: "119000000" }],
    });
    expect(paid.statusCode).toBe(200);
    const detail = (
      await call("editor", "GET", `/invoices/${invoiceId}`)
    ).json();
    expect(detail).toMatchObject({ status: "paid", openAmountMicros: "0" });
    // Postings of an invoice or payment are corrected by voiding, not by a
    // generic reversal.
    for (const id of [entryId, paid.json().entryId]) {
      const reversed = await call("editor", "POST", `/entries/${id}/reverse`, {
        reason: "Wrong",
      });
      expect(reversed.statusCode).toBe(409);
      expect(error(reversed)).toBe("FINANCE_USE_VOID");
    }
    const voided = await call(
      "editor",
      "POST",
      `/payments/${paid.json().paymentId}/void`,
      {
        reason: "Wrong account",
      },
    );
    expect(voided.statusCode).toBe(200);
    // A manual entry is reversed directly.
    const manual = await call("editor", "POST", "/entries", {
      kind: "contribution",
      accountId: bank,
      amount: "500.00",
      date: "2026-10-02",
      currency: "USD",
    });
    expect(manual.statusCode).toBe(200);
    const reversal = await call(
      "editor",
      "POST",
      `/entries/${manual.json().entryId}/reverse`,
      { reason: "Booked twice" },
    );
    expect(reversal.statusCode).toBe(200);
    // An export is stored and downloaded as an attachment.
    const exported = await call("editor", "POST", "/exports", {
      kind: "journal_csv",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(exported.statusCode).toBe(201);
    const file = await call(
      "editor",
      "GET",
      `/exports/${exported.json().id}/file`,
    );
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/^attachment; /);
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    const listed = (await call("editor", "GET", "/exports")).json();
    expect(listed.items[0]).toMatchObject({ id: exported.json().id });
    expect(typeof listed.items[0].rowCount).toBe("number");
  });

  it("invoice detail marks voided payments and payment entries name their invoices", async () => {
    const { invoiceId } = await uploadAndBook("editor");
    const bank = (await call("owner", "GET", "/accounts"))
      .json()
      .items.find((a: { code: string }) => a.code === "1000").id;
    const paid = await call("editor", "POST", "/payments", {
      direction: "outgoing",
      accountId: bank,
      date: "2026-10-05",
      currency: "USD",
      amountMicros: "119000000",
      allocations: [{ invoiceId, amountMicros: "119000000" }],
    });
    expect(paid.statusCode).toBe(200);
    const live = (await call("editor", "GET", `/invoices/${invoiceId}`)).json();
    expect(live.allocations).toHaveLength(1);
    expect(live.allocations[0].voidedAt).toBeNull();
    const payment = (
      await call("editor", "GET", `/entries/${paid.json().entryId}`)
    ).json();
    expect(payment.paymentInvoices).toEqual([
      { id: invoiceId, number: expect.anything() },
    ]);
    await call("editor", "POST", `/payments/${paid.json().paymentId}/void`, {
      reason: "Wrong account",
    });
    const after = (
      await call("editor", "GET", `/invoices/${invoiceId}`)
    ).json();
    expect(after.allocations).toHaveLength(1);
    expect(typeof after.allocations[0].voidedAt).toBe("string");
  });
});
