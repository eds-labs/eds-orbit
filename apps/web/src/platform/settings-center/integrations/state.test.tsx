import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateBadge, stateTone } from "./state";
import { stateLabel } from "./texts";
import { INTEGRATION_STATES } from "./types";

describe("StateBadge", () => {
  it("labels a state without deriving one", () => {
    const html = renderToStaticMarkup(<StateBadge state="needs_attention" locale="de" />);
    expect(html).toContain(stateLabel("needs_attention", "de"));
    expect(html).not.toContain(stateLabel("needs_attention", "en"));
    for (const state of INTEGRATION_STATES) {
      const out = renderToStaticMarkup(<StateBadge state={state} locale="en" />);
      expect(out).toContain(stateLabel(state, "en"));
      expect(out).toContain(`badge-${stateTone[state]}`);
    }
  });

  it("never lets a failed or stored state look successful", () => {
    expect(stateTone.needs_attention).toBe("danger");
    expect(stateTone.stored).toBe("warning");
    expect(stateTone.not_set_up).toBe("neutral");
    expect(stateTone.disabled).toBe("neutral");
  });
});

describe("StateBadge with an unknown state", () => {
  it("renders the raw value in the neutral tone", () => {
    const html = renderToStaticMarkup(<StateBadge state={"future_state" as never} locale="en" />);
    expect(html).toContain("future_state");
    expect(html).toContain("badge-neutral");
    expect(html).not.toContain("badge-success");
  });
});
