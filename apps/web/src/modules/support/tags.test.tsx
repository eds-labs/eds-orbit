import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TagChip, TagPicker, finalizeTags, tagKey } from "./tags";
import { ticketQuery } from "./api";
import { supportText } from "./labels";

const defs = [
  { key: "vip", label: "VIP", color: "purple" as const },
  { key: "bug", label: "Bug", color: "red" as const },
];

describe("support tags (Chatwoot-style labels)", () => {
  it("derives a valid, unique key from the label", () => {
    expect(tagKey("VIP Kunde", [])).toBe("vip_kunde");
    expect(tagKey("Rückzahlung", [])).toBe("ruckzahlung");
    expect(tagKey("2FA", [])).toBe("t_2fa");
    expect(tagKey("!", [])).toBe("tag");
    expect(tagKey("VIP", ["vip"])).toBe("vip_2");
    expect(tagKey("VIP", ["vip", "vip_2"])).toBe("vip_3");
    expect(tagKey("x".repeat(80), [])).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });

  it("keys new rows by their final label and never re-keys existing ones", () => {
    expect(
      finalizeTags([
        { key: "vip", label: "VIP Gold ", color: "purple" },
        { key: "new:1", label: "VIP", color: "blue" },
        { key: "new:2", label: "  ", color: "red" },
        { key: "new:3", label: "Bug", color: "red" },
      ]),
    ).toEqual([
      { key: "vip", label: "VIP Gold", color: "purple" },
      { key: "vip_2", label: "VIP", color: "blue" },
      { key: "bug", label: "Bug", color: "red" },
    ]);
  });

  it("shows a tag with its label and colour, an unlisted one plainly", () => {
    const chip = renderToStaticMarkup(<TagChip tag="vip" defs={defs} />);
    expect(chip).toContain('data-color="purple"');
    expect(chip).toContain(">VIP<");
    const legacy = renderToStaticMarkup(<TagChip tag="old" defs={defs} />);
    expect(legacy).toContain('data-color="gray"');
    expect(legacy).toContain(">old<");
  });

  it("offers every listed tag as a toggle, pressed when set", () => {
    const html = renderToStaticMarkup(
      <TagPicker
        defs={defs}
        value={["bug", "old"]}
        onChange={() => undefined}
        t={supportText("de")}
      />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    // An unlisted tag already on the ticket can still be removed.
    expect(html).toContain(">old<");
    const none = renderToStaticMarkup(
      <TagPicker
        defs={[]}
        value={[]}
        onChange={() => undefined}
        t={supportText("de")}
      />,
    );
    expect(none).toContain(supportText("de").noTagsDefined);
  });

  it("filters the ticket list by tag and category", () => {
    expect(ticketQuery({ view: "all", tag: "vip", category: "billing" })).toBe(
      "view=all&tag=vip&category=billing",
    );
  });
});
