import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { centerHref, mapOldAddress, moduleTabIndex } from "@/platform/settings-center/redirects";
import { manageHref } from "@/platform/settings-center/routes";
import { PLATFORM_TAB_KEYS } from "@/platform/settings-center/sections/project";
import { routeTable } from "@/platform/shell/routes";
import {
  AI_SETTINGS_PLACE,
  dataClassRouteWarning,
  exceptionText,
  hasExceptionText,
  SOCIAL_AUTOPILOT_PLACE,
  type ExceptionPlace,
} from "./exception-text";

describe("exceptionText", () => {
  it("explains the data-class block and links the AI settings", () => {
    const de = exceptionText("de", "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA");
    expect(de.title).toBe("KI-Anbieter für Kundendaten nicht erlaubt");
    expect(de.cause).toContain("dürfen nur an OpenAI gehen");
    expect(de.cause).toContain("bevor etwas gesendet");
    expect(de.action).toContain("Route auf ein verifiziertes OpenAI-Modell stellen");
    expect(de.action).toContain("nie von selbst");
    expect(de.place).toBe(AI_SETTINGS_PLACE);
    const en = exceptionText("en", "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA");
    expect(en.action).toContain("verified OpenAI model");
    expect(en.place).toEqual({ area: "ai" });
  });

  it("has German and English texts for the Postiz queue codes", () => {
    for (const code of ["POSTIZ_QUEUE_STALLED", "POSTIZ_QUEUE_CHECK_FAILED"]) {
      const de = exceptionText("de", code);
      const en = exceptionText("en", code);
      expect(de.title).not.toBe(code);
      expect(en.title).not.toBe(code);
      expect(de.title).not.toBe(en.title);
      expect(de.cause && de.action && en.cause && en.action).toBeTruthy();
      expect(hasExceptionText(code)).toBe(true);
    }
  });

  it("explains an autopilot post held on Social and links the owner's switch", () => {
    const de = exceptionText("de", "AUTOPILOT_ON_SOCIAL_NOT_APPROVED");
    expect(de.title).toBe("Autopilot-Post wartet auf deine Freigabe");
    expect(de.cause).toContain("„Autopilot über Social“");
    expect(de.action).toBe(
      "Post selbst in den Freigaben freigeben oder „Autopilot über Social“ einschalten.",
    );
    const en = exceptionText("en", "AUTOPILOT_ON_SOCIAL_NOT_APPROVED");
    expect(en.title).toBe("Autopilot post waits for your release");
    expect(en.action).toContain("“Autopilot through Social”");
    expect(de.place).toBe(SOCIAL_AUTOPILOT_PLACE);
    expect(en.place).toEqual({
      area: "modules",
      rest: ["marketing", "policy"],
      hash: "#social-autopilot",
    });
    expect(hasExceptionText("AUTOPILOT_ON_SOCIAL_NOT_APPROVED")).toBe(true);
  });

  it("reuses the budget layer's texts and accepts codes with spaces", () => {
    const text = exceptionText("en", "BUDGET EXCEEDED");
    expect(text.cause).toBe(
      "The project's AI budget for today or this month is used up.",
    );
    expect(text.place).toBe(AI_SETTINGS_PLACE);
  });

  it("keeps an unknown code and gives other unclear outcomes a generic text", () => {
    expect(exceptionText("de", "SOMETHING_NEW")).toEqual({
      title: "SOMETHING_NEW",
      cause: "",
      action: "",
    });
    expect(hasExceptionText("SOMETHING_NEW")).toBe(false);
    expect(exceptionText("en", "EMAIL_OUTCOME_UNKNOWN").title).toBe(
      "Outcome unclear",
    );
    // The generic text does not replace the code in lists.
    expect(hasExceptionText("EMAIL_OUTCOME_UNKNOWN")).toBe(false);
    expect(exceptionText("en", null).title).toBe("—");
  });
});

describe("exception places", () => {
  // The center address of a place is what the redirect table gives for the
  // old address it replaces.
  const ctx = {
    table: routeTable(webRegistry),
    tabs: moduleTabIndex(webRegistry.modules),
    platformKeys: PLATFORM_TAB_KEYS,
    moduleShown: () => true,
  };
  const viaTable = (search: string, hash = "") => {
    const target = mapOldAddress(
      { pathname: "/p/p1/settings", search, hash },
      ctx,
    );
    return centerHref(target as Exclude<typeof target, "wait" | null>);
  };
  const named = (place: ExceptionPlace) =>
    manageHref({ kind: "project", projectId: "p1" }, place.area, ...(place.rest ?? [])) +
    (place.hash ?? "");

  it("names the sections the old settings addresses led to", () => {
    expect(named(AI_SETTINGS_PLACE)).toBe(viaTable("?section=ai"));
    expect(named(SOCIAL_AUTOPILOT_PLACE)).toBe(
      viaTable("?section=policy", "#social-autopilot"),
    );
    for (const code of [
      "POSTIZ_QUEUE_CHECK_FAILED",
      "TELEGRAM_DELIVERY_FAILED",
      "MATOMO_SCHEDULED_IMPORT_FAILED",
    ]) {
      const place = exceptionText("en", code).place;
      expect(place, code).toBeDefined();
      expect(named(place!), code).toBe(viaTable("?section=integrations"));
    }
  });
});

describe("dataClassRouteWarning", () => {
  it("names the blocked support routes and the setting, without promising a switch", () => {
    const text = dataClassRouteWarning("de", [
      {
        task: "support_triage",
        dataClass: "customer_personal",
        provider: "anthropic",
        allowed: ["openai"],
        enforced: true,
      },
    ])!;
    expect(text).toContain("Support-Einordnung (Claude)");
    expect(text).toContain("AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA");
    expect(text).toContain("Aufgaben-Routen");
    expect(text).toContain("nicht automatisch");
  });

  it("says a finance route is not stopped yet, and nothing for no routes", () => {
    const text = dataClassRouteWarning("en", [
      {
        task: "finance_extraction",
        dataClass: "financial",
        provider: "anthropic",
        allowed: ["openai"],
        enforced: false,
      },
    ])!;
    expect(text).toContain("does not stop this route yet");
    expect(text).not.toContain("AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA");
    expect(dataClassRouteWarning("en", [])).toBeNull();
  });

});

describe("creative authority codes", () => {
  it("are explained in both languages", () => {
    const codes = [
      "CREATIVE_AUTHORITY_OFF",
      "CREATIVE_NOT_FOUND",
      "CREATIVE_NOT_USABLE",
      "CREATIVE_RENDITION_NOT_ON_POST",
      "CREATIVE_VISION_REVIEW_REQUIRED",
      "CREATIVE_VISION_NOT_PASSED",
      "CREATIVE_RENDITION_NOT_REVIEWED",
      "CREATIVE_QA_NEEDS_OWNER",
    ];
    for (const code of codes) {
      expect(hasExceptionText(code)).toBe(true);
      expect(exceptionText("de", code).title).not.toBe(code);
      expect(exceptionText("en", code).action).toBeTruthy();
    }
    expect(exceptionText("de", "CREATIVE_VISION_REVIEW_REQUIRED").title).toContain("Bildprüfung");
    expect(exceptionText("en", "CREATIVE_VISION_REVIEW_REQUIRED").title).toContain("vision review");
  });
});
