import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { manageHref } from "../routes";
import { EffectiveAiView } from "./effective-view";
import { originLabel, OriginBadge } from "./origin-badge";
import type { ProjectAiEffective, TracedRoute } from "./types";

// The "organization standard" case of the API's effective view: the project
// follows its organization's Claude standard with one deviation, a granted
// OpenAI connection and an own Claude key.
const notExplicit: TracedRoute = {
  stored: null,
  effective: {
    model: "claude-sonnet-fixture",
    maxOutputTokens: 3000,
    provider: "anthropic",
    price: "current",
  },
  explicit: false,
  origin: "organization",
};
const budget = {
  monthlyMicros: 40_000_000,
  warnMicros: 20_000_000,
  warn2Micros: 30_000_000,
  stopMicros: 35_000_000,
  anchorDay: 1,
};
function fixture(over: Partial<ProjectAiEffective> = {}): ProjectAiEffective {
  return {
    projectId: "p1",
    routingMode: "organization",
    routingApplied: true,
    standardSource: "organization",
    exceptions: {
      models: false,
      routes: true,
      prices: false,
      providerBudgets: false,
      keys: ["anthropic"],
    },
    defaultProvider: {
      stored: "openai",
      effective: "anthropic",
      origin: "organization",
    },
    tiers: {
      openai: {
        fast: {
          stored: "gpt-fixture-fast",
          effective: "gpt-fixture-fast",
          origin: "system",
        },
        standard: {
          stored: null,
          effective: "gpt-fixture-standard",
          origin: "system",
        },
        quality: {
          stored: null,
          effective: "gpt-fixture-quality",
          origin: "system",
        },
        escalation: {
          stored: null,
          effective: "gpt-fixture-quality",
          origin: "system",
        },
      },
      anthropic: {
        fast: {
          stored: null,
          effective: "claude-haiku-fixture",
          origin: "organization",
        },
        standard: {
          stored: null,
          effective: "claude-sonnet-fixture",
          origin: "organization",
        },
        quality: { stored: null, effective: null, origin: null },
      },
    },
    taskRoutes: {
      chat_operator: notExplicit,
      draft_social: {
        stored: { model: "gpt-fixture-standard", maxOutputTokens: 1800 },
        effective: {
          model: "gpt-fixture-standard",
          reasoningEffort: "low",
          maxOutputTokens: 1800,
          provider: "openai",
          price: "current",
        },
        explicit: true,
        origin: "project",
      },
      support_triage: {
        stored: null,
        effective: { error: "MODEL_CAPABILITY_NOT_VERIFIED" },
        explicit: true,
        origin: "organization",
      },
    },
    // As the API returns it: a saved row always defines the fallback.
    fallback: { stored: "openai", effective: "openai", origin: "project" },
    imageModel: {
      stored: "gpt-image-fixture",
      effective: "gpt-image-fixture",
      origin: "project",
    },
    keys: {
      openai: {
        stored: false,
        effective: true,
        origin: "organization",
        connection: {
          label: "Synthetic standard OpenAI",
          status: "read_verified",
          disabled: false,
        },
      },
      // No dedicated image key: image calls use the OpenAI text key.
      image: {
        stored: false,
        effective: true,
        origin: "organization",
        connection: {
          label: "Synthetic standard OpenAI",
          status: "read_verified",
          disabled: false,
        },
      },
      anthropic: {
        stored: true,
        effective: true,
        origin: "project",
        connection: null,
      },
    },
    providerBudgets: {
      openai: { stored: null, effective: budget, origin: "organization" },
      anthropic: { stored: null, effective: null, origin: null },
    },
    readiness: {
      openai: {
        stored: true,
        verified: true,
        ready: false,
        reasons: ["no_text_route"],
      },
      anthropic: {
        stored: true,
        verified: false,
        ready: true,
        reasons: ["project_key_unverifiable"],
      },
    },
    ...over,
  };
}

const scope = { kind: "project", projectId: "p1" } as const;
const hrefOf = (area: string, ...rest: string[]) =>
  manageHref(scope, area, ...rest);
const render = (data: ProjectAiEffective, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <EffectiveAiView data={data} locale={locale} hrefOf={hrefOf} />,
  );
/** The table row that holds `text`. */
const rowOf = (html: string, text: string) => {
  const row = html
    .split("<tr")
    .slice(1)
    .find((part) => part.includes(text));
  expect(row, `no row with ${text}`).toBeDefined();
  return row!;
};

describe("originLabel", () => {
  it("names every origin, none, and an unknown one as itself", () => {
    expect(originLabel("organization", "en")).toBe("Organization");
    expect(originLabel("preset", "de")).toBe("Eigene Stufe");
    expect(originLabel(null, "en")).toBe("Not set");
    expect(originLabel("future" as never, "en")).toBe("future");
    expect(
      renderToStaticMarkup(
        <OriginBadge origin="project" exception locale="en" />,
      ),
    ).toContain("Exception");
  });
});

describe("EffectiveAiView", () => {
  it("shows each value with its origin and marks project exceptions", () => {
    const html = render(fixture());
    const provider = rowOf(html, "Default provider");
    expect(provider).toContain("Claude");
    expect(provider).toContain(originLabel("organization", "en"));
    expect(provider).not.toContain("Exception");
    expect(rowOf(html, "gpt-fixture-fast")).toContain(
      originLabel("system", "en"),
    );
    // The deviating route of the standard is the project's exception.
    const social = rowOf(html, "Social drafts");
    expect(social).toContain("gpt-fixture-standard");
    expect(social).toContain("Exception");
    // Not explicit routes are summed up; an unknown error code shows as itself.
    expect(html).not.toContain("Assistant chat");
    expect(html).toContain("Other tasks use the default provider&#x27;s tier.");
    expect(rowOf(html, "Support triage")).toContain(
      "MODEL_CAPABILITY_NOT_VERIFIED",
    );
    // A Claude tier without a value: not set, no origin.
    const quality = rowOf(html, "Claude tier: quality");
    expect(quality).toContain("not set");
    expect(quality).toContain(originLabel(null, "en"));
    expect(rowOf(html, "When the Claude budget is stopped")).toContain(
      "Fall back to OpenAI",
    );
    // The image key is the text key's connection.
    const image = rowOf(html, "Image key");
    expect(image).toContain("Synthetic standard OpenAI");
    expect(image).toContain("Key checked");
    expect(rowOf(html, "Claude key")).toContain("Exception");
    expect(rowOf(html, "Budget OpenAI")).toContain("$40.00 per month");
    expect(rowOf(html, "Budget Claude")).toContain("not set");
  });

  it("marks no exception while the project's own settings apply", () => {
    const custom = render(
      fixture({ routingMode: "custom", standardSource: null }),
    );
    expect(custom).not.toContain("Exception");
    // A saved standard the runtime does not apply leaves the row in charge too.
    const off = render(fixture({ routingApplied: false }));
    expect(off).not.toContain(">Exception<");
  });

  it("states the mode, the standard's source and routing that is off", () => {
    expect(render(fixture())).toContain(
      "Follows the organization&#x27;s standard.",
    );
    const system = render(fixture({ standardSource: "system" }));
    expect(system).toContain("Orbit&#x27;s standard applies");
    expect(render(fixture())).not.toContain("Orbit&#x27;s standard applies");
    // Only while the standard applies; otherwise routingOff explains (review Minor 5).
    expect(
      render(fixture({ standardSource: "system", routingApplied: false })),
    ).not.toContain("Orbit&#x27;s standard applies");
    expect(render(fixture())).not.toContain("not switched on");
    expect(render(fixture({ routingApplied: false }))).toContain(
      "Standard models and presets are not switched on for this installation, so the project&#x27;s own settings apply until they are.",
    );
    expect(
      render(fixture({ routingMode: "custom", routingApplied: false })),
    ).not.toContain("not switched on");
    expect(render(fixture({ routingMode: "unsaved" }))).toContain(
      "No own AI settings",
    );
    expect(render(fixture({ routingMode: "preset" }), "de")).toContain(
      "Eigene Stufe: eine für dieses Projekt",
    );
    expect(render(fixture({ routingMode: "future" as never }))).toContain(
      "future",
    );
    // The exceptions line names the parts and the own keys.
    const html = render(fixture());
    expect(html).toContain("Set by this project:");
    expect(html).toMatch(/routes, own keys \(Claude key\)/);
    const none = render(
      fixture({
        exceptions: {
          models: false,
          routes: false,
          prices: false,
          providerBudgets: false,
          keys: [],
        },
      }),
    );
    // Nothing listed, but the fallback, image model and Claude key still come
    // from the project: no claim that every value is inherited.
    expect(none).not.toContain("No exceptions");
    expect(none).not.toContain("Set by this project:");
  });

  it("says when neither the organization nor Orbit has set a standard (P4-R12)", () => {
    const none = render(fixture({ standardSource: null }));
    expect(none).toContain(
      "Neither the organization nor Orbit has set a standard yet; the table below shows what applies until then.",
    );
    expect(none.indexOf("Follows the organization")).toBeLessThan(none.indexOf("Neither the organization"));
    expect(render(fixture({ standardSource: null }), "de")).toContain(
      "Weder die Organisation noch Orbit hat bisher einen Standard festgelegt",
    );
    for (const source of ["organization", "system"] as const)
      expect(render(fixture({ standardSource: source }))).not.toContain("Neither the organization");
    // While no standard applies, routingOff explains instead.
    expect(render(fixture({ standardSource: null, routingApplied: false }))).not.toContain(
      "Neither the organization",
    );
    expect(render(fixture({ routingMode: "custom", standardSource: null }))).not.toContain(
      "Neither the organization",
    );
  });

  it("shows the three readiness marks and the reasons", () => {
    const html = render(fixture());
    const claude = rowOf(html, "project&#x27;s own key cannot be checked");
    expect(claude).toMatch(
      /data-ok="true"[^>]*><span aria-hidden="true">[✓–] <\/span>Key available<span class="sr-only">: yes<\/span>/,
    );
    expect(claude).toMatch(
      /data-ok="false"[^>]*><span aria-hidden="true">[✓–] <\/span>Key checked<span class="sr-only">: no<\/span>/,
    );
    expect(claude).toMatch(
      /data-ok="true"[^>]*><span aria-hidden="true">[✓–] <\/span>Ready for text<span class="sr-only">: yes<\/span>/,
    );
    expect(rowOf(html, "No text task uses this provider.")).toMatch(
      /data-ok="true"[^>]*><span aria-hidden="true">[✓–] <\/span>Key checked<span class="sr-only">: yes<\/span>/,
    );
    const unknown = render(
      fixture({
        readiness: {
          openai: {
            stored: false,
            verified: false,
            ready: false,
            reasons: ["no_key", "future_reason" as never],
          },
          anthropic: {
            stored: true,
            verified: false,
            ready: false,
            reasons: ["connection_disabled"],
          },
        },
      }),
    );
    expect(unknown).toContain("No key for this provider.");
    expect(unknown).toContain("future_reason");
    expect(unknown).toContain("The connection is disabled.");
  });

  it("reads each mark's state in German too", () => {
    const html = render(fixture(), "de");
    expect(html).toContain(
      'Schlüssel geprüft<span class="sr-only">: nein</span>',
    );
    expect(html).toContain(
      'Schlüssel vorhanden<span class="sr-only">: ja</span>',
    );
  });

  it("links to the sections that change the values", () => {
    const html = render(fixture());
    expect(html).toContain(`href="${hrefOf("ai", "models")}"`);
    expect(html).toContain(`href="${hrefOf("ai", "providers")}"`);
    expect(html).toContain(`href="${hrefOf("ai", "budget")}"`);
    expect(hrefOf("ai", "models")).toBe("/manage/p/p1/ai/models");
  });
});

describe("exceptions follow the API's exceptions (P4-R7)", () => {
  const nothing = {
    models: false,
    routes: false,
    prices: false,
    providerBudgets: false,
    keys: [],
  };
  // A project on the standard that set nothing of its own: the API still
  // reports the fallback as the project's, as every saved row defines it.
  const following = () =>
    fixture({
      exceptions: nothing,
      taskRoutes: { chat_operator: notExplicit },
      keys: {
        ...fixture().keys,
        anthropic: {
          stored: false,
          effective: false,
          origin: null,
          connection: null,
        },
      },
    });

  it("marks no exception and claims none inherited for a project that set nothing", () => {
    const html = render(following());
    expect(rowOf(html, "When the Claude budget is stopped")).toContain(
      "This project",
    );
    expect(html).not.toContain("Exception");
    expect(html).not.toContain("No exceptions");
    expect(html).not.toContain("Set by this project:");
  });

  it("says no exceptions when every value is inherited", () => {
    const inherited = following();
    const html = render(
      fixture({
        ...inherited,
        routingMode: "unsaved",
        standardSource: null,
        fallback: { stored: null, effective: "none", origin: "system" },
        imageModel: {
          stored: null,
          effective: "gpt-image-fixture",
          origin: "organization",
        },
      }),
    );
    expect(html).not.toContain("This project");
    expect(html).toContain("No exceptions: every value is inherited.");
  });

  it("marks an override route of the standard but not the project's own fallback", () => {
    const html = render(fixture({ exceptions: { ...nothing, routes: true } }));
    expect(rowOf(html, "Social drafts")).toContain("Exception");
    const fallback = rowOf(html, "When the Claude budget is stopped");
    expect(fallback).toContain("This project");
    expect(fallback).not.toContain("Exception");
    expect(rowOf(html, "Image key")).not.toContain("Exception");
    // The Claude key is the project's own but not listed: no exception.
    expect(rowOf(html, "Claude key")).not.toContain("Exception");
  });

  it("marks budgets and keys only when listed", () => {
    const html = render(
      fixture({
        providerBudgets: {
          openai: {
            stored: budget,
            effective: budget,
            origin: "project",
          },
          anthropic: { stored: null, effective: null, origin: null },
        },
        exceptions: { ...nothing, providerBudgets: true, keys: ["anthropic"] },
      }),
    );
    expect(rowOf(html, "Budget OpenAI")).toContain("Exception");
    expect(rowOf(html, "Claude key")).toContain("Exception");
    expect(rowOf(html, "Image model")).not.toContain("Exception");
  });
});
