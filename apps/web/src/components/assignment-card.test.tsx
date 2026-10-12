import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignmentCard, type AssignmentContent } from "./assignment-card";

const CONSENT =
  "Generierte Bilder dürfen für diesen Auftrag verwendet werden (keine Logos, keine echten Personen, kein Text im Bild)";
const assignment = (image: boolean): AssignmentContent => ({
  id: "assignment",
  version: 1,
  name: "Two posts a day",
  kind: "standing",
  contentType: "social",
  channels: ["x-int", "tg-int"],
  channelNames: { "x-int": "Synthetic X", "tg-int": "Synthetic Telegram" },
  schedule: {
    rhythm: "weekly",
    weekdays: [1, 3],
    times: ["10:00", "17:00"],
    leadMinutes: 360,
  },
  topicFrame: "Beta access for product teams",
  tone: "Calm and factual",
  image,
  styleAssetIds: ["style-1", "style-2"],
  vetoMinutes: 180,
  monthlyBudgetMicros: 50_000_000,
  actionRequestId: "request",
});
const render = (image: boolean, canDecide = true) =>
  renderToStaticMarkup(
    <AssignmentCard
      expiresAt="2026-10-16T12:00:00.000Z"
      assignment={assignment(image)}
      status="draft"
      request={{
        id: "request",
        version: 1,
        packageHash: "a".repeat(64),
        status: "pending",
      }}
      de
      canDecide={canDecide}
      pending={false}
      onConfirm={() => {}}
      onReject={() => {}}
    />,
  );
const confirmButton = (html: string) =>
  html.match(/<button[^>]*>Auftrag bestätigen<\/button>/)?.[0];

describe("AssignmentCard", () => {
  it("shows every field the owner confirms", () => {
    const html = render(false);
    for (const text of [
      "Two posts a day",
      "Wöchentlich",
      "Mo, Mi",
      "10:00, 17:00",
      "Synthetic X, Synthetic Telegram",
      "Social-Post",
      "Beta access for product teams",
      "Calm and factual",
      "2 Stilreferenzen",
      "180 Minuten",
      "$50.00",
    ])
      expect(html).toContain(text);
    expect(html).toContain("Nein");
    // The request's expiry, as in every other owner decision.
    expect(html).toContain("gültig bis");
    expect(html).toMatch(/datetime="2026-10-16T12:00:00.000Z"/i);
  });

  it("requires the consent checkbox for image assignments", () => {
    const html = render(true);
    expect(html).toContain(CONSENT);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*required=""/);
    // Confirm stays disabled until the consent is ticked.
    expect(confirmButton(html)).toContain('disabled=""');

    const plain = render(false);
    expect(plain).not.toContain(CONSENT);
    expect(confirmButton(plain)).toBeDefined();
    expect(confirmButton(plain)).not.toContain("disabled");
  });

  it("shows the delivery the owner confirms", () => {
    expect(render(false)).toContain("Veröffentlichen nach dem Veto-Fenster");
    const html = renderToStaticMarkup(
      <AssignmentCard
        assignment={{ ...assignment(false), delivery: "postiz_draft" }}
        status="draft"
        request={{
          id: "request",
          version: 1,
          packageHash: "a".repeat(64),
          status: "pending",
        }}
        de
        canDecide
        pending={false}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );
    expect(html).toContain("Zustellung");
    expect(html).toContain("Als Entwurf in Postiz (du veröffentlichst selbst)");
    expect(html).toContain("Entfällt – Orbit veröffentlicht nichts");
    expect(html).toContain("Veröffentlichen machst du selbst in Postiz");
    expect(html).not.toContain("wenn du sie nicht stoppst");
  });

  it("shows a shared text and the format the owner confirms (R76, R77)", () => {
    const card = (changes: Partial<AssignmentContent>) =>
      renderToStaticMarkup(
        <AssignmentCard
          assignment={{ ...assignment(true), ...changes }}
          status="draft"
          request={null}
          de
          canDecide={false}
          pending={false}
          onConfirm={() => {}}
          onReject={() => {}}
        />,
      );
    const shared = card({
      sharedAcrossChannels: true,
      format: {
        minChars: 600,
        maxChars: 900,
        hashtags: { min: 2, max: 3 },
        paragraphs: true,
        cta: "https://desk.example.invalid/en/register",
      },
    });
    expect(shared).toContain("Beiträge");
    expect(shared).toContain("Ein Text und ein Bild für alle Kanäle");
    expect(shared).toContain(
      "600–900 Zeichen · 2–3 Hashtags · kurze Absätze · Link https://desk.example.invalid/en/register",
    );
    // A card from before R76/R77: one text per channel, no format.
    const plain = card({});
    expect(plain).toContain("Eigener Text je Kanal");
    expect(plain).toContain("Ohne Vorgabe");
    expect(plain).not.toContain("Ein Text und ein Bild für alle Kanäle");
  });

  it("lets only a person who may decide confirm", () => {
    const html = render(true, false);
    expect(confirmButton(html)).toBeUndefined();
    expect(html).not.toContain(CONSENT);
    expect(html).toContain("Wartet auf Bestätigung durch den Owner");
  });
});
