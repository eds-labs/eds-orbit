import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import type { SettingsConnection, WebmailMailbox } from "./api";
import { GrantEditorView, type GrantRow } from "./grants";
import { webmailText } from "./labels";
import {
  convertHandlerFor,
  EmptyMailboxes,
  lastErrorText,
  mailboxOptionLabel,
  mailboxStatus,
  MailboxPicker,
  selectMailbox,
  WithdrawnNotice,
} from "./overview";
import {
  changeRight,
  hasAnyRight,
  NO_RIGHTS,
  rightLocked,
  rightsOf,
} from "./rights";
import { ConnectionRowView, isConflict, sensitiveLocked, settingsError } from "./settings";

const t = webmailText("en");

const mailbox = (over: Partial<WebmailMailbox> = {}): WebmailMailbox => ({
  id: "m1",
  address: "info@example.com",
  displayName: "Info",
  sensitive: false,
  capabilities: { read: true, send: false, organize: false, convert: false, manage: false },
  status: "ok",
  sync: "ok",
  lastError: null,
  ...over,
});

describe("rights", () => {
  const read = { ...NO_RIGHTS, canRead: true };

  it("starts with no access", () => {
    expect(rightsOf(null)).toEqual(NO_RIGHTS);
    expect(hasAnyRight(rightsOf(null))).toBe(false);
  });

  it("cannot add another right without read", () => {
    expect(changeRight(NO_RIGHTS, "canSend", true)).toEqual(NO_RIGHTS);
  });

  it("adds and removes a right beside read", () => {
    const send = changeRight(read, "canSend", true);
    expect(send).toEqual({ ...read, canSend: true });
    expect(changeRight(send, "canSend", false)).toEqual(read);
  });

  it("removes everything with read", () => {
    const all = { canRead: true, canSend: true, canOrganize: true, canConvert: true, canManage: true };
    expect(changeRight(all, "canRead", false)).toEqual(NO_RIGHTS);
  });

  it("keeps the others when read is switched on", () => {
    expect(changeRight({ ...NO_RIGHTS, canManage: true }, "canRead", true)).toEqual({
      ...NO_RIGHTS,
      canRead: true,
      canManage: true,
    });
  });

  it("locks the others until read is on, but never locks a right to remove", () => {
    expect(rightLocked(NO_RIGHTS, "canRead")).toBe(false);
    expect(rightLocked(NO_RIGHTS, "canSend")).toBe(true);
    expect(rightLocked(read, "canSend")).toBe(false);
    expect(rightLocked({ ...NO_RIGHTS, canManage: true }, "canManage")).toBe(false);
  });
});

describe("the grant editor", () => {
  const row = (rights = NO_RIGHTS): GrantRow => ({
    member: { userId: "u1", name: "Ada", email: "ada@example.com", grant: null },
    rights,
  });
  const render = (rows: GrantRow[], busy: string | null = null, locale: "en" | "de" = "en") =>
    renderToStaticMarkup(
      <GrantEditorView t={webmailText(locale)} rows={rows} busy={busy} error={null} onChange={() => {}} />,
    );

  it("offers a manager no manage right and no change to another manager", () => {
    const html = renderToStaticMarkup(
      <GrantEditorView
        t={webmailText("en")}
        rows={[row({ ...NO_RIGHTS, canManage: true })]}
        busy={null}
        error={null}
        restricted
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain(webmailText("en").grants.rights.canManage);
    expect(html.match(/<input/g)?.length).toBe(html.match(/disabled=""/g)?.length);
  });

  it("says that nobody has access by default and that read is required", () => {
    const html = render([row()]);
    expect(html).toContain(t.settings.noAccessDefault);
    expect(html).toContain(t.grants.readRequired);
    expect(html).toContain(t.grants.noAccess);
  });

  it("shows all five rights in both languages", () => {
    for (const label of Object.values(t.grants.rights)) expect(render([row()])).toContain(label);
    for (const label of Object.values(webmailText("de").grants.rights))
      expect(render([row()], null, "de")).toContain(label);
  });

  it("disables the other rights until read is on", () => {
    expect(render([row()]).match(/<input[^>]*disabled/g)).toHaveLength(4);
    expect(render([row({ ...NO_RIGHTS, canRead: true })]).match(/<input[^>]*disabled/g)).toBeNull();
  });

  it("waits while a change is saved", () => {
    expect(render([row()], "u1").match(/<input[^>]*disabled/g)).toHaveLength(5);
  });

  it("does not mark a member with rights as having none", () => {
    expect(render([row({ ...NO_RIGHTS, canRead: true })])).not.toContain(t.grants.noAccess);
  });
});

describe("the connection rows", () => {
  const connection = (over: Partial<SettingsConnection> = {}): SettingsConnection => ({
    connectionId: "c1",
    address: "info@example.com",
    owner: null,
    opened: { id: "m1", enabled: true, sensitive: false, displayName: null, version: 3 },
    ...over,
  });
  const render = (c: SettingsConnection, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <ConnectionRowView
        t={t}
        connection={c}
        busy={false}
        confirming={false}
        showingAccess={false}
        access={<span>editor</span>}
        onOpen={() => {}}
        onToggleEnabled={() => {}}
        onToggleSensitive={() => {}}
        onAskClose={() => {}}
        onCancelClose={() => {}}
        onConfirmClose={() => {}}
        onToggleAccess={() => {}}
        {...over}
      />,
    );

  it("offers to open a mailbox that is not opened", () => {
    const html = render(connection({ opened: null }));
    expect(html).toContain(t.settings.open);
    expect(html).toContain(t.settings.notOpened);
    expect(html).not.toContain(t.settings.showAccess);
  });

  it("shows the switches of an opened mailbox", () => {
    const html = render(connection());
    expect(html).toContain(t.settings.enabled);
    expect(html).toContain(t.settings.sensitive);
    expect(html).toContain(t.settings.showAccess);
    expect(html).not.toContain(t.settings.ownedByFinance);
  });

  it("marks a Finance mailbox and locks it as sensitive", () => {
    const finance = connection({
      owner: "finance",
      opened: { id: "m1", enabled: true, sensitive: false, displayName: null, version: 3 },
    });
    expect(sensitiveLocked(finance)).toBe(true);
    const html = render(finance);
    expect(html).toContain(t.settings.ownedByFinance);
    expect(html).toContain(t.settings.sensitiveLocked);
    const sensitive = html.match(/<input[^>]*aria-describedby="locked-m1"[^>]*>/)?.[0];
    expect(sensitive).toContain('checked=""');
    expect(sensitive).toContain('disabled=""');
  });

  it("marks a mailbox another module owns without locking it", () => {
    const support = connection({ owner: "support" });
    expect(sensitiveLocked(support)).toBe(false);
    expect(render(support)).toContain("Used by support");
  });

  it("asks before removing a mailbox", () => {
    expect(render(connection(), { confirming: true })).toContain(t.settings.closeConfirm);
    expect(render(connection())).not.toContain(t.settings.closeConfirm);
  });

  it("shows the grant editor only when asked", () => {
    expect(render(connection())).not.toContain("editor");
    expect(render(connection(), { showingAccess: true })).toContain("editor");
  });

  it("treats a stale version as a conflict and says so", () => {
    const conflict = new ApiError("WEBMAIL_VERSION_CONFLICT", 409);
    expect(isConflict(conflict)).toBe(true);
    expect(settingsError(conflict, t)).toBe(t.settings.conflict);
    expect(isConflict(new ApiError("X", 500))).toBe(false);
    expect(settingsError(new ApiError("X", 403), t)).toBe(t.settings.forbidden);
    expect(settingsError(new Error("x"), t)).toBe(t.settings.failed);
  });
});

describe("the mailbox page", () => {
  it("says that an owner must grant access, and nothing about other mailboxes", () => {
    for (const locale of ["en", "de"] as const) {
      const html = renderToStaticMarkup(<EmptyMailboxes t={webmailText(locale)} />);
      expect(html).toMatch(/owner/i);
      expect(html).not.toMatch(/\b(other|others|weitere|andere)\b/i);
      expect(html).not.toMatch(/\b(no mailboxes exist|keine postfächer vorhanden)\b/i);
    }
  });

  it("opens the first mailbox without a deep link", () => {
    const a = mailbox({ id: "a" });
    const b = mailbox({ id: "b" });
    expect(selectMailbox([a, b], null)).toEqual({ mailbox: a, missing: false });
  });

  it("opens the mailbox of the deep link", () => {
    const a = mailbox({ id: "a" });
    const b = mailbox({ id: "b" });
    expect(selectMailbox([a, b], "b")).toEqual({ mailbox: b, missing: false });
  });

  it("opens nothing for an id the server did not list", () => {
    expect(selectMailbox([mailbox({ id: "a" })], "z")).toEqual({ mailbox: null, missing: true });
  });

  it.each([
    [{ status: "ok", sync: "ok" }, "ok", t.status.ok],
    [{ status: "ok", sync: "backlog" }, "warning", t.status.backlog],
    [{ status: "ok", sync: "error" }, "error", t.status.syncError],
    [{ status: "error", sync: "ok" }, "error", t.status.connectionError],
    [{ status: "disabled", sync: "error" }, "off", t.status.disabled],
  ] as const)("describes %j", (state, tone, label) => {
    expect(mailboxStatus(state, t)).toEqual({ tone, label });
  });

  it("never shows a raw error code", () => {
    expect(lastErrorText(null, t)).toBeNull();
    expect(lastErrorText("IMAP_ERROR", t)).toBe(t.lastError.IMAP_ERROR);
    expect(lastErrorText("SOMETHING_NEW", t)).toBe(t.lastError.unknown);
  });

  it("names a mailbox in the menu with its state unless it is fine", () => {
    expect(mailboxOptionLabel(mailbox(), t)).toBe("Info (info@example.com)");
    expect(
      mailboxOptionLabel(
        mailbox({ address: "b@example.com", displayName: null, sync: "error", sensitive: true }),
        t,
      ),
    ).toBe(`b@example.com · ${t.status.syncError} · ${t.sensitive}`);
  });

  it("offers every mailbox in a menu and shows the open one's state", () => {
    const second = mailbox({
      id: "m2",
      address: "b@example.com",
      displayName: null,
      sync: "error",
      lastError: "IMAP_ERROR",
      sensitive: true,
    });
    const html = renderToStaticMarkup(
      <MailboxPicker t={t} mailboxes={[mailbox(), second]} selected={second} onSelect={() => {}} />,
    );
    expect(html).toContain("<select");
    expect(html).toContain(t.picker);
    expect(html).toContain('<option value="m1">Info (info@example.com)</option>');
    expect(html).toMatch(/<option value="m2" selected="">b@example\.com/);
    expect(html).toContain(t.status.syncError);
    expect(html).toContain(t.lastError.IMAP_ERROR);
    expect(html).toContain(t.sensitive);
    expect(html).not.toContain("IMAP_ERROR");
  });

  it("shows a single mailbox as text, without a menu", () => {
    const html = renderToStaticMarkup(
      <MailboxPicker t={t} mailboxes={[mailbox()]} selected={mailbox()} onSelect={() => {}} />,
    );
    expect(html).not.toContain("<select");
    expect(html).toContain("Info (info@example.com)");
    expect(html).toContain(t.status.ok);
  });

  it("asks for a choice when the deep link names no listed mailbox", () => {
    const html = renderToStaticMarkup(
      <MailboxPicker t={t} mailboxes={[mailbox()]} selected={null} onSelect={() => {}} />,
    );
    expect(html).toContain("<select");
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a mailbox<\/option>/);
    expect(html).not.toContain(t.status.ok);
  });

  it("says access was withdrawn and offers no way to reopen", () => {
    const html = renderToStaticMarkup(<WithdrawnNotice t={t} address="info@example.com" />);
    expect(html).toContain("Your access to info@example.com was withdrawn.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(t.embed.reopen);
  });

  it("does not act on takeover requests without the right to convert", () => {
    const handler = () => {};
    const can = { read: true, send: false, organize: false, convert: true, manage: false };
    expect(convertHandlerFor(mailbox(), handler)).toBeNull();
    expect(convertHandlerFor(null, handler)).toBeNull();
    expect(convertHandlerFor(mailbox({ capabilities: can }), handler)).toBe(handler);
  });

  it("has a text for every key in both languages", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
        : typeof value;
    expect(shape(webmailText("de"))).toEqual(shape(webmailText("en")));
  });
});
