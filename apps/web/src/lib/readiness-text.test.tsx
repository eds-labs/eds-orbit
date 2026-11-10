import { describe, expect, it } from "vitest";
import {
  actionLabel,
  actionOrder,
  activationErrorText,
  blockerReason,
} from "./readiness-text";
import { READINESS_BLOCKERS } from "../../../api/src/modules/marketing/readiness/blocker-catalog";
import { readinessActions } from "../../../api/src/modules/marketing/readiness/action-readiness";

// Every readiness code the server describes (the MCP blocker catalog) and
// every action it reports needs German and English wording here, so the
// settings card, Operations and the overview never show a raw code. The web
// keeps its own copy; this test stops the two drifting apart.

const locales = ["en", "de"] as const;
// Fallback of blockerReason/actionLabel for a missing entry.
const raw = (code: string) => code.replaceAll("_", " ");

describe("readiness wording (server and web)", () => {
  it("words every blocker code of the catalog in German and English", () => {
    const missing = locales.flatMap((locale) =>
      Object.keys(READINESS_BLOCKERS)
        .filter((code) => blockerReason(locale, code) === raw(code))
        .map((code) => `${locale}:${code}`),
    );
    expect(missing).toEqual([]);
  });

  it("labels every action in German and English", () => {
    const missing = locales.flatMap((locale) =>
      readinessActions
        .filter((action) => actionLabel(locale, action) === raw(action))
        .map((action) => `${locale}:${action}`),
    );
    expect(missing).toEqual([]);
  });

  it("lists every action once, the generic publish_* rows instead of postiz_*", () => {
    expect(new Set(actionOrder).size).toBe(actionOrder.length);
    expect(actionOrder.filter((a) => !readinessActions.includes(a))).toEqual(
      [],
    );
    expect(
      readinessActions.filter(
        (a) => !(actionOrder as readonly string[]).includes(a),
      ),
    ).toEqual(["postiz_draft", "postiz_schedule", "postiz_live"]);
  });

  it("names the drain and Social codes without Postiz wording for Social", () => {
    expect(blockerReason("de", "PUBLISHER_WRITE_VERIFICATION_REQUIRED")).toBe(
      "Schreibzugriff auf Postiz ist noch nicht geprüft.",
    );
    expect(
      blockerReason("de", "SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED"),
    ).not.toMatch(/Postiz/);
    expect(blockerReason("en", "PUBLISHING_BACKEND_DRAINING")).toMatch(
      /Postiz/,
    );
  });

  it("words a refused live activation and leaves other errors as they are", () => {
    expect(
      activationErrorText(
        "de",
        "LIVE_ACTIVATION_BLOCKED:AUTOPILOT_ON_SOCIAL_NOT_APPROVED",
      ),
    ).toBe(
      "Live-Autopilot über Social ist noch nicht freigegeben (Entscheidung des Owners ausstehend).",
    );
    expect(
      activationErrorText(
        "en",
        "LIVE_ACTIVATION_BLOCKED:PROJECT_PAUSED,EXECUTION_MODE_TEST",
      ),
    ).toBe(
      "The project is paused. Orbit runs in test mode; live posts are off.",
    );
    expect(activationErrorText("en", "OWNER_REQUIRED")).toBe("OWNER_REQUIRED");
    expect(activationErrorText("en", null)).toBeNull();
  });
});
