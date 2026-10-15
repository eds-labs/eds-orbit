import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageCard, type ContentPackage } from "./chat-package-card";

const pkg = (rightsApproved: boolean): ContentPackage => ({
  id: "package",
  goal: "Announce the tagline",
  status: "completed",
  ceilingMicros: 1470000,
  actionRequest: null,
  deliverables: [],
  image: {
    prompt: "Calm abstract dashboard",
    maxCostMicros: 1000000,
    status: "generated",
    assetId: "asset",
    rightsApproved,
    href: null,
    errorCode: null,
  },
});
const render = (rightsApproved: boolean) =>
  renderToStaticMarkup(
    <PackageCard
      pkg={pkg(rightsApproved)}
      de
      canStart={false}
      pending={false}
      onStart={() => {}}
      onCancel={() => {}}
    />,
  );

describe("PackageCard image status", () => {
  it("names the open rights review before the owner approved the image", () => {
    expect(render(false)).toContain("Erzeugt, Rechteprüfung offen");
  });

  it("stops calling the rights review open once the owner approved it", () => {
    // Production 2026-10-06: the badge still read "Rechteprüfung offen" next
    // to "Nutzungsrechte bestätigt."
    const html = render(true);
    expect(html).not.toContain("Rechteprüfung offen");
    expect(html).toContain("Erzeugt, Rechte bestätigt");
  });
});
