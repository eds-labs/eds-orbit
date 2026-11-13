import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { shellLinks } from "@/platform/shell/shell-links";
import { supportText } from "./labels";
import { MailboxesManagedNote } from "./settings";

// The production link builder.
const render = (locale: "en" | "de" = "en") => {
  const hrefOf = (key: string) => `/p/demo/${key}`;
  const shell = {
    hrefOf,
    ...shellLinks({ hrefOf, projectId: "p1", map: (href) => `/center${href}` }),
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <MailboxesManagedNote t={supportText(locale)} />
    </ShellContext.Provider>,
  );
};

describe("support mailbox note", () => {
  it("says where mailboxes are managed and links to the center's connections", () => {
    const html = render();
    // React escapes the apostrophe in markup.
    expect(html).toContain(
      "Mailboxes are added and checked in the project&#x27;s connections.",
    );
    expect(html).toContain('href="/center/p/demo/connectors"');
    expect(html).toContain("Open mailboxes");
  });
  it("words the note in German too", () => {
    const html = render("de");
    expect(html).toContain(
      "Postfächer werden unter Verbindungen angelegt und geprüft.",
    );
    expect(html).toContain('href="/center/p/demo/connectors"');
    expect(html).toContain("Postfächer öffnen");
  });
  it("keeps the existing mailbox hint texts", () => {
    const t = supportText("en");
    expect(t.settings.mailboxHint).toContain("Owners connect mailboxes");
    expect(t.settings.mailboxNone).toContain("No verified mailbox yet");
  });
});
