import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./chat-markdown";

describe("ChatMarkdown", () => {
  it("renders common plan formatting without enabling model-supplied HTML or links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={
          "## Weekly plan\n\n**Period:** 28 Sep–4 Oct\n- X\n- Telegram\n\n> Review first\n\n<script>alert(1)</script> [click](javascript:alert(1))"
        }
      />,
    );
    expect(html).toContain("<h3>Weekly plan</h3>");
    expect(html).toContain("<strong>Period:</strong>");
    expect(html).toContain("<ul><li>X</li><li>Telegram</li></ul>");
    expect(html).toContain("<blockquote>Review first</blockquote>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
  });
});
