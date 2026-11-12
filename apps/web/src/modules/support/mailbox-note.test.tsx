import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { shellLinks } from "@/platform/shell/shell-links";
import { supportText } from "./labels";
import { MailboxesManagedNote } from "./settings";

// The production link builder, so the flag states are the real ones.
const render = (stage: "off" | "on", locale: "en" | "de" = "en") => {
  const hrefOf = (key: string) => `/p/demo/${key}`;
  const shell = {
    hrefOf,
    ...shellLinks({ stage, hrefOf, map: (href) => `/center${href}` }),
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <MailboxesManagedNote t={supportText(locale)} />
    </ShellContext.Provider>,
  );
};

describe("support mailbox note", () => {
  it("says where mailboxes are managed and links to the old connectors page", () => {
    const html = render("off");
    expect(html).toContain(
      "Mailboxes are added and checked under Integrations.",
    );
    expect(html).toContain('href="/p/demo/connectors"');
    expect(html).toContain("Open mailboxes");
  });
  it("links to the center's connections with the flag on, in German", () => {
    const html = render("on", "de");
    expect(html).toContain(
      "Postfächer werden unter Integrationen angelegt und geprüft.",
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
