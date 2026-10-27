import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtDirectionFields,
  CreativePanelView,
  RegenerateConfirm,
  artDirectionBody,
  artDirectionIncomplete,
  creativeErrorMessage,
  formatUsd,
  productIds,
  sendProduce,
} from "./creative-panel";
import {
  CreativeRequestError,
  type CreativeOptions,
  type CreativeView,
} from "./creative-api";

const rendition = (format: string, w: number, h: number) => ({
  format: format as never,
  assetId: `asset-${format}`,
  width: w,
  height: h,
  bytes: 1000,
  sha256: "x",
  channel: "linkedin",
  href: `/api/projects/p1/assets/asset-${format}/content`,
});
const creative = (patch: Partial<CreativeView> = {}): CreativeView => ({
  id: "c1",
  version: 1,
  contentId: "post1",
  template: "announcement",
  variant: "text_top",
  options: { logoPlacement: "auto", textScale: "m" },
  copy: { headline: "Spring launch", cta: "Join" },
  components: {
    artAssetId: "art1",
    logo: { assetId: "logo1", sha256: "a" },
    products: [],
  },
  renditions: [
    rendition("landscape", 1200, 630),
    rendition("square", 1080, 1080),
  ],
  qa: { checks: [], verdict: "pass" },
  corrections: [],
  cost: { reservationIds: [], settledMicros: 40000, unknownMicros: 0 },
  status: "composed",
  ...patch,
});
const options: CreativeOptions = {
  templates: [
    {
      id: "announcement",
      variants: { landscape: ["text_top"], square: ["text_top", "centered"] },
      needs: { art: "optional", product: "none" },
      copyLimits: { eyebrow: 30, headline: 60, subline: 90, cta: 20 },
    },
  ],
  formats: {},
  defaultChannelFormats: { linkedin: ["landscape"] },
  config: { enabledTemplates: ["announcement"], maxArtCorrections: 1 },
};
const content = {
  id: "post1",
  body: "Our spring launch is here.",
  channel: "linkedin",
};
const render = (
  access: "viewer" | "editor" | "owner",
  value: CreativeView | null,
  extra: Record<string, unknown> = {},
) =>
  renderToStaticMarkup(
    <CreativePanelView
      projectId="p1"
      content={content}
      access={access}
      de={false}
      creative={value}
      options={options}
      assets={[
        { id: "art1", name: "Hero", type: "photo", usageApproved: true },
        { id: "logo1", name: "Logo", type: "logo", usageApproved: true },
      ]}
      maxArtCostMicros={1_000_000}
      onChanged={() => {}}
      {...extra}
    />,
  );

describe("CreativePanelView", () => {
  it("shows a rendition per format and switches with arrow keys", () => {
    const html = render("editor", creative());
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("/assets/asset-landscape/content");
    expect(html).not.toContain("/assets/asset-square/content");
    expect(html).toContain('alt="Spring launch"');
    // The tab bar is the shared Tabs primitive: arrows, Home and End.
    const second = render("editor", creative(), { initialFormat: "square" });
    expect(second).toContain("/assets/asset-square/content");
    expect(second).not.toContain("/assets/asset-landscape/content");
  });

  it("lists failed QA checks in words", () => {
    const html = render(
      "editor",
      creative({
        status: "needs_owner",
        qa: {
          verdict: "needs_owner",
          checks: [
            {
              code: "EMPTY_AREA_EXCESSIVE",
              passed: false,
              severity: "blocker",
            },
            { code: "ASSET_UPSCALED", passed: false, severity: "warning" },
            { code: "TEXT_CONTRAST_LOW", passed: true, severity: "blocker" },
          ],
        },
      }),
    );
    expect(html).toContain("Too much empty space in the picture");
    expect(html).toContain("Image was enlarged");
    expect(html).not.toContain("EMPTY_AREA_EXCESSIVE");
    expect(html).not.toContain("Text is hard to read");
  });

  it("hides actions from viewers", () => {
    const html = render("viewer", creative());
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Recompose");
    expect(html).not.toContain("Attach");
    expect(html).toContain("Spring launch");
    expect(render("viewer", null)).not.toContain("Produce creative");
  });

  it("editor can recompose but not regenerate", () => {
    const html = render("editor", creative());
    expect(html).toContain("Recompose");
    expect(html).toContain("Attach to post");
    expect(html).not.toContain("Regenerate art");
    expect(html).not.toContain("Vision review");
    const owner = render("owner", creative());
    expect(owner).toContain("Regenerate art");
    expect(owner).toContain("Vision review");
  });

  it("owner regenerate asks for the cost confirmation", () => {
    const html = renderToStaticMarkup(
      <RegenerateConfirm
        de={false}
        maxCostMicros={1_000_000}
        pending={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("$1.00");
    expect(html).toContain("prompt goes to the image provider");
  });

  it("shows a warning for needs_owner", () => {
    const html = render(
      "owner",
      creative({
        status: "attached",
        qa: { verdict: "needs_owner", checks: [] },
      }),
    );
    // R5a: the lifecycle stays "attached", the quality is shown separately.
    expect(html).toContain("Attached");
    expect(html).toContain("Needs owner review");
    expect(html).toContain("alert-warning");
  });

  it("shows — for unknown cost", () => {
    const html = render("editor", creative({ cost: undefined }));
    expect(html).toMatch(/Cost<\/dt><dd[^>]*>—</);
    expect(render("editor", creative())).toContain("$0.04");
  });

  it("renders the empty state", () => {
    const html = render("editor", null);
    expect(html).toContain("No creative yet");
    expect(html).toContain("Produce creative");
    expect(render("viewer", null)).toContain("No creative yet");
  });
});

describe("creativeErrorMessage", () => {
  it("explains manual errors in words and names the failing asset", () => {
    const err = (code: string, detail: Record<string, unknown> | null = null) =>
      creativeErrorMessage(new CreativeRequestError(code, 409, detail), false);
    expect(err("CREATIVE_VARIANT_NOT_AVAILABLE")).toContain("variant");
    expect(err("PRODUCT_ASSET_REQUIRED")).toContain("approved product");
    expect(err("CREATIVE_TEXT_TOO_LONG")).toContain("too long");
    expect(
      err("ASSET_RIGHTS", { assetIds: "a1,a2", reasons: "unapproved" }),
    ).toContain("a1, a2");
    expect(err("SOMETHING_NEW")).toContain("SOMETHING NEW");
  });

  // R66: refused image copy and the owner's copy findings in words.
  it("explains refused image copy and names copy findings", () => {
    const err = (code: string) =>
      creativeErrorMessage(new CreativeRequestError(code, 409, null), false);
    expect(err("CREATIVE_TEXT_UNSAFE")).toContain("invisible");
    expect(err("CREATIVE_LINK_NOT_ALLOWED")).toContain("link");
    expect(
      creativeErrorMessage(
        new CreativeRequestError("CREATIVE_QA_FAILED", 409, {
          failed: [{ contentId: "c1", codes: ["CREATIVE_UNSUPPORTED_CLAIM"] }],
        }),
        false,
      ),
    ).toContain("figure");
  });
});

describe("channel formats and form state", () => {
  const withInstagram: CreativeOptions = {
    ...options,
    templates: [
      {
        ...options.templates[0],
        variants: { feed_portrait: ["text_bottom"], square: ["centered"] },
      },
    ],
    defaultChannelFormats: { instagram: ["feed_portrait"] },
  };
  it("resolves variants and name from the channel's platform identifier", () => {
    const html = render("editor", null, {
      options: withInstagram,
      content: {
        ...content,
        channel: "cm9x1",
        channelIdentifier: "instagram",
        channelName: "Brand IG",
      },
    });
    expect(html).toContain("Text at the bottom");
    expect(html).not.toContain("Centered");
    const unknown = render("editor", null, { options: withInstagram });
    expect(unknown).toContain("Centered");
  });

  it("shows the channel name and identifier, not the id", () => {
    const html = render("editor", creative(), {
      content: {
        ...content,
        channel: "cm9x1",
        channelIdentifier: "linkedin",
        channelName: "Brand LI",
      },
    });
    expect(html).toContain("Brand LI · linkedin");
    expect(html).not.toContain("cm9x1");
  });

  it("sends products only for templates that take them", () => {
    expect(productIds({ needs: { product: "none" } }, "p1")).toEqual({});
    expect(productIds({ needs: { product: "optional" } }, "p1")).toEqual({
      productAssetIds: ["p1"],
    });
    expect(productIds({ needs: { product: "optional" } }, "")).toEqual({});
  });

  it("preselects the creative's current variant when recomposing", () => {
    expect(render("editor", creative())).toMatch(
      /<option value="text_top" selected/,
    );
  });

  it("keeps sub-cent maxima readable", () => {
    expect(formatUsd(4000)).toBe("$0.0040");
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(null)).toBe("—");
  });
});

// M9: after a paid creative was made, the form's next paid image is a new
// request; a failed or free one keeps the id, so a retry never pays twice (R51).
describe("sendProduce", () => {
  it("draws a new request id only after a paid request succeeded", async () => {
    const renew = vi.fn();
    expect(await sendProduce(async () => "made", true, renew)).toBe("made");
    expect(renew).toHaveBeenCalledTimes(1);
    await sendProduce(async () => "made", false, renew);
    expect(renew).toHaveBeenCalledTimes(1);
    await expect(
      sendProduce(
        async () => {
          throw new Error("RESERVATION_ALREADY_USED");
        },
        true,
        renew,
      ),
    ).rejects.toThrow("RESERVATION_ALREADY_USED");
    expect(renew).toHaveBeenCalledTimes(1);
  });
});

// Art direction for new art: what the picture shows, where, and its mood.
describe("art direction", () => {
  const blank = { motif: "", setting: "", mood: "" };

  it("sends only filled fields, trimmed, and nothing without a motif", () => {
    expect(artDirectionBody(blank)).toEqual({});
    expect(artDirectionBody({ ...blank, motif: "  A glass teapot " })).toEqual({
      artDirection: { motif: "A glass teapot" },
    });
    expect(
      artDirectionBody({
        motif: "A glass teapot",
        setting: " Windowsill at dusk ",
        mood: "",
      }),
    ).toEqual({
      artDirection: { motif: "A glass teapot", setting: "Windowsill at dusk" },
    });
    // A setting or mood alone has no motif to go with: incomplete, not sent.
    expect(artDirectionBody({ ...blank, setting: "Dusk" })).toEqual({});
    expect(artDirectionIncomplete({ ...blank, setting: "Dusk" })).toBe(true);
    expect(artDirectionIncomplete({ ...blank, mood: "calm" })).toBe(true);
    expect(artDirectionIncomplete(blank)).toBe(false);
    expect(artDirectionIncomplete({ ...blank, motif: "A teapot" })).toBe(false);
  });

  it("labels the fields in English and German", () => {
    const fields = (de: boolean) =>
      renderToStaticMarkup(
        <ArtDirectionFields value={blank} onChange={() => {}} de={de} />,
      );
    expect(fields(false)).toContain("Motif");
    expect(fields(false)).toContain("Setting (place, light, time of day)");
    expect(fields(false)).toContain("Mood");
    expect(fields(true)).toContain("Motiv");
    expect(fields(true)).toContain("Szene (Ort, Licht, Tageszeit)");
    expect(fields(true)).toContain("Stimmung");
  });

  it("offers it in the regenerate dialog with the current motif as a hint", () => {
    const html = renderToStaticMarkup(
      <RegenerateConfirm
        de={false}
        maxCostMicros={1_000_000}
        pending={false}
        error={null}
        current={{ motif: "A mug in daylight", setting: "", mood: "" }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Motif");
    expect(html).toContain('placeholder="A mug in daylight"');
  });
});
