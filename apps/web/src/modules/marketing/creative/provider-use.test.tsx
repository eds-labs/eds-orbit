import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderUseControl, providerUseBody } from "./provider-use";

const asset = (patch: Record<string, unknown> = {}) => ({
  id: "logo-1",
  version: 4,
  approved: true,
  providerUse: false,
  ...patch,
});

// I2: the owner sets "May be sent to AI providers" on an approved asset.
describe("provider use of an asset", () => {
  it("sends the asset's version with its approval and the new provider use", () => {
    expect(providerUseBody(asset(), true)).toEqual({
      assetId: "logo-1",
      version: 4,
      assetStatus: "approved",
      confirmUsageRights: true,
      providerUse: true,
    });
    expect(providerUseBody(asset({ providerUse: true }), false)).toMatchObject({
      providerUse: false,
    });
  });

  it("offers the owner a checkbox with the current state", () => {
    const html = (providerUse: boolean) =>
      renderToStaticMarkup(
        <ProviderUseControl
          asset={asset({ providerUse })}
          isOwner
          de={false}
          pending={false}
          onChange={() => {}}
        />,
      );
    expect(html(false)).toContain("May be sent to AI providers");
    expect(html(false)).not.toContain("checked");
    expect(html(true)).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(
      renderToStaticMarkup(
        <ProviderUseControl
          asset={asset()}
          isOwner
          de
          pending
          onChange={() => {}}
        />,
      ),
    ).toMatch(/disabled=""[^>]*\/> Darf an KI-Anbieter gesendet werden/);
  });

  it("shows others the state read-only and nothing for an asset that is not approved", () => {
    const viewer = (providerUse: boolean) =>
      renderToStaticMarkup(
        <ProviderUseControl
          asset={asset({ providerUse })}
          isOwner={false}
          de={false}
          pending={false}
          onChange={() => {}}
        />,
      );
    expect(viewer(true)).toContain("May be sent to AI providers: yes");
    expect(viewer(false)).toContain("May be sent to AI providers: no");
    expect(viewer(true)).not.toContain("<input");
    expect(
      renderToStaticMarkup(
        <ProviderUseControl
          asset={asset({ approved: false })}
          isOwner
          de={false}
          pending={false}
          onChange={() => {}}
        />,
      ),
    ).toBe("");
  });
});
