import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Inbox } from "lucide-react";
import { Metric } from "./metric";

describe("Metric", () => {
  it("renders the label, the amount and a hidden icon", () => {
    const html = renderToStaticMarkup(
      <Metric icon={Inbox} label="Open" amount="12" />,
    );
    expect(html).toContain('class="metric"');
    expect(html).toContain('<span class="metric-label">Open</span>');
    expect(html).toContain("<strong>12</strong>");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain("<small>");
  });

  it("adds the detail line when given", () => {
    expect(
      renderToStaticMarkup(
        <Metric
          icon={Inbox}
          label="Budget"
          amount="$1.00"
          detail="of $10.00"
        />,
      ),
    ).toContain("<small>of $10.00</small>");
  });
});
