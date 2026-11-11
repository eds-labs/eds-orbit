import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MailboxList,
  mailboxFields,
  serverGroups,
  type MailServerPreset,
} from "./email-connection";

const mailbox = (
  id: string,
  smtpHost: string,
  fromAddress: string,
  extra: Record<string, unknown> = {},
) => ({
  connection: {
    id,
    data: {
      smtpHost,
      smtpPort: 587,
      smtpTls: "starttls",
      imapHost: "imap.a.test",
      imapPort: 143,
      imapTls: "starttls",
      username: `user-${id}`,
      fromAddress,
      fromName: `Name ${id}`,
      status: "verified",
      ...extra,
    },
  },
  default: false,
  inUse: 0,
  inbound: null,
});

const SERVER_FIELDS = [
  "smtpHost",
  "smtpPort",
  "smtpTls",
  "imapHost",
  "imapPort",
  "imapTls",
];
const byName = (fields: ReturnType<typeof mailboxFields>) =>
  Object.fromEntries(fields.map((f) => [f.name, f.value]));

describe("mailboxFields", () => {
  // The form as it was before the extraction, copied from the old inline list.
  it("keeps today's form without a preset", () => {
    const fields = mailboxFields(null, "en");
    expect(
      fields.map((f) => [
        f.name,
        f.label,
        f.type,
        f.required,
        f.value,
        f.heading,
      ]),
    ).toEqual([
      ["fromAddress", "Address", "email", true, "", undefined],
      ["fromName", "Sender name", undefined, undefined, "", undefined],
      ["username", "User name", undefined, true, "", undefined],
      ["password", "Password", "password", true, undefined, undefined],
      ["smtpHost", "SMTP server", undefined, true, "", "SMTP"],
      ["smtpPort", "SMTP port", "number", undefined, 465, undefined],
      ["smtpTls", "SMTP security", "select", undefined, "implicit", undefined],
      ["imapHost", "IMAP server", undefined, true, "", "IMAP"],
      ["imapPort", "IMAP port", "number", undefined, 993, undefined],
      ["imapTls", "IMAP security", "select", undefined, "implicit", undefined],
    ]);
    expect(fields.find((f) => f.name === "smtpTls")?.options).toEqual([
      { value: "implicit", label: "TLS (implicit)" },
      { value: "starttls", label: "STARTTLS" },
    ]);
    expect(mailboxFields(null, "de")[0].label).toBe("Adresse");
  });

  it("fills an existing mailbox and never its password", () => {
    const current = mailbox("m1", "mail.a.test", "a@a.test").connection.data;
    const values = byName(mailboxFields(current, "en"));
    expect(values).toMatchObject({
      fromAddress: "a@a.test",
      fromName: "Name m1",
      username: "user-m1",
      smtpHost: "mail.a.test",
      smtpPort: 587,
      smtpTls: "starttls",
      imapHost: "imap.a.test",
      imapPort: 143,
      imapTls: "starttls",
    });
    expect(values.password).toBeUndefined();
  });

  const preset: MailServerPreset = {
    smtpHost: "mail.a.test",
    smtpPort: 587,
    smtpTls: "starttls",
    imapHost: "imap.a.test",
    imapPort: 143,
    imapTls: "starttls",
  };

  it("prefills a new mailbox from its server", () => {
    const values = byName(mailboxFields(null, "en", preset));
    expect(values).toMatchObject(preset);
    expect(values.fromAddress).toBe("");
  });

  it("carries nothing but the six server fields from a preset", () => {
    const plain = mailboxFields(null, "en");
    const withPreset = mailboxFields(null, "en", preset);
    for (const field of withPreset.filter(
      (f) => !SERVER_FIELDS.includes(f.name),
    )) {
      expect(field).toEqual(plain.find((f) => f.name === field.name));
    }
    expect(withPreset.map((f) => f.name)).toEqual(plain.map((f) => f.name));
  });
});

describe("serverGroups", () => {
  it("groups mailboxes by SMTP host", () => {
    const groups = serverGroups([
      mailbox("1", "mail.a.test", "1@a.test"),
      mailbox("2", "mail.b.test", "2@b.test"),
      mailbox("3", "mail.a.test", "3@a.test"),
    ]);
    expect(groups.map((g) => g.host)).toEqual(["mail.a.test", "mail.b.test"]);
    expect(groups.map((g) => g.mailboxes.length)).toEqual([2, 1]);
    expect(groups[0].mailboxes.map((m) => m.connection.id)).toEqual(["1", "3"]);
  });

  it("compares hosts case-insensitively and trimmed, in first-connected order", () => {
    const groups = serverGroups([
      mailbox("1", "Mail.B.test", "1@b.test"),
      mailbox("2", "Mail.A.test", "2@a.test"),
      mailbox("3", "mail.b.test ", "3@b.test"),
    ]);
    expect(groups.map((g) => g.host)).toEqual(["Mail.B.test", "Mail.A.test"]);
    expect(groups[0].mailboxes.map((m) => m.connection.id)).toEqual(["1", "3"]);
  });

  it("takes the preset from the first mailbox and nothing mailbox-specific", () => {
    const [group] = serverGroups([
      mailbox("1", "mail.a.test", "1@a.test", {
        smtpPort: 465,
        smtpTls: "implicit",
      }),
      mailbox("2", "mail.a.test", "2@a.test"),
    ]);
    expect(Object.keys(group.preset).sort()).toEqual([...SERVER_FIELDS].sort());
    expect(group.preset).toMatchObject({ smtpPort: 465, smtpTls: "implicit" });
    expect(JSON.stringify(group.preset)).not.toContain("1@a.test");
  });

  it("keeps a mailbox without an SMTP host in a last group", () => {
    const groups = serverGroups([
      mailbox("1", "", "1@x.test"),
      mailbox("2", "mail.a.test", "2@a.test"),
    ]);
    expect(groups.map((g) => g.host)).toEqual(["mail.a.test", ""]);
    expect(groups[1].mailboxes).toHaveLength(1);
  });
});

describe("MailboxList", () => {
  const rows = [
    mailbox("1", "mail.a.test", "1@a.test"),
    mailbox("2", "mail.b.test", "2@b.test"),
  ];
  const render = (groupByServer: boolean, de = false) =>
    renderToStaticMarkup(
      <MailboxList
        mailboxes={rows}
        groupByServer={groupByServer}
        de={de}
        locale={de ? "de" : "en"}
        timezone="Europe/Berlin"
        pending={false}
        onCheck={() => {}}
        onEdit={() => {}}
        onRemove={() => {}}
        onAddOnServer={() => {}}
      />,
    );

  it("renders one h3 and one add button per server when grouped", () => {
    const html = render(true);
    expect(html.match(/<h3[ >]/g)).toHaveLength(2);
    expect(html).toContain("Mail server mail.a.test");
    expect(html).toContain("Mail server mail.b.test");
    expect(html.match(/Add mailbox on this server<\/button>/g)).toHaveLength(2);
    // The host is part of the button's accessible name.
    expect(html).toContain(
      'aria-label="Add mailbox on this server mail.a.test"',
    );
    expect(html).toContain("1@a.test");
  });

  it("speaks German when asked", () => {
    const html = render(true, true);
    expect(html).toContain("Mailserver mail.a.test");
    expect(html).toContain("Postfach auf diesem Server hinzufügen");
  });

  it("renders the flat list unchanged without grouping", () => {
    const html = render(false);
    expect(html).not.toContain("<h3");
    expect(html).not.toContain("on this server");
    expect(html.match(/<ul class="mailbox-rows">/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
