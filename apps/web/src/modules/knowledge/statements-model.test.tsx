import { describe, expect, it } from "vitest";
import type { Entity } from "@/lib/api";
import {
  bulkSummary,
  confirmAll,
  decisionPayload,
  effectiveRights,
  effectiveStatement,
  groupByTopic,
  MAX_STATEMENT_LENGTH,
  selectable,
  TOPICS,
} from "./statements-model";
import { knowledgeCopy } from "./workspace-text";

const de = knowledgeCopy.de;
const en = knowledgeCopy.en;

const proposal = (
  id: string,
  data: Record<string, unknown> = {},
  version = 1,
) =>
  ({
    id,
    version,
    data: {
      status: "pending",
      topic: "description",
      statement: `Statement ${id}`,
      draftId: "d1",
      ...data,
    },
  }) as unknown as Entity;
const draft = (id: string, rights?: Record<string, boolean>) =>
  ({
    id,
    version: 1,
    data: { status: "draft", input: { kind: "text", name: id, rights } },
  }) as unknown as Entity;

describe("statements model", () => {
  it("groups in topic order and hides empty topics", () => {
    const groups = groupByTopic([
      proposal("a", { topic: "limitations" }),
      proposal("b", { topic: "audience" }),
      proposal("c", { topic: "limitations" }),
    ]);
    expect(groups.map((g) => g.topic)).toEqual(["audience", "limitations"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(TOPICS[0]).toBe("description");
  });

  it("puts an unknown topic under description", () => {
    const groups = groupByTopic([
      proposal("a", { topic: "legacy" }),
      proposal("b", { topic: undefined }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.topic).toBe("description");
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("rights come from the draft", () => {
    const rights = { marketing: false, support: true, publicUse: true };
    expect(
      effectiveRights(proposal("a"), [
        draft("d1", { ...rights, modelUse: true }),
      ]),
    ).toEqual(rights);
  });

  it("a card edit beats the draft", () => {
    const d = draft("d1", { marketing: true, support: true, publicUse: false });
    expect(
      effectiveRights(proposal("a"), [d], { support: false, publicUse: true }),
    ).toEqual({ marketing: true, support: false, publicUse: true });
  });

  it("a missing draft or missing rights gets the defaults", () => {
    const defaults = { marketing: true, support: true, publicUse: false };
    expect(effectiveRights(proposal("a"), [])).toEqual(defaults);
    expect(effectiveRights(proposal("a"), [draft("d1")])).toEqual(defaults);
  });

  it("an empty edited statement is not selectable", () => {
    expect(selectable(proposal("a"), [], { statement: "   " })).toBe(false);
    expect(selectable(proposal("a"), [], { statement: " ok " })).toBe(true);
    expect(effectiveStatement(proposal("a"), { statement: "x" })).toBe("x");
    expect(effectiveStatement(proposal("a"))).toBe("Statement a");
  });

  it("a statement over the API limit is not selectable", () => {
    expect(MAX_STATEMENT_LENGTH).toBe(1000);
    const at = { statement: ` ${"a".repeat(1000)} ` };
    const over = { statement: "a".repeat(1001) };
    expect(selectable(proposal("a"), [], at)).toBe(true);
    expect(selectable(proposal("a"), [], over)).toBe(false);
  });

  it("no audience is not selectable", () => {
    const d = draft("d1", {
      marketing: false,
      support: false,
      publicUse: false,
    });
    expect(selectable(proposal("a"), [d])).toBe(false);
    expect(selectable(proposal("a"), [d], { marketing: true })).toBe(true);
  });

  it("needs_review is not selectable", () => {
    expect(selectable(proposal("a", { status: "needs_review" }), [])).toBe(
      false,
    );
    expect(selectable(proposal("a", { status: "accepted" }), [])).toBe(false);
  });

  it("summary for uniform rights", () => {
    const sel = Array.from({ length: 12 }, (_, i) =>
      proposal(`p${i}`, { draftId: i < 5 ? "pub" : "int" }),
    );
    const drafts = [
      draft("pub", { marketing: true, support: true, publicUse: true }),
      draft("int", { marketing: true, support: true, publicUse: false }),
    ];
    expect(bulkSummary(sel, drafts, {}, de).text).toBe(
      "12 Aussagen · Marketing und Support · 5 öffentlich",
    );
    expect(bulkSummary(sel, drafts, {}, en).text).toBe(
      "12 statements · Marketing and Support · 5 public",
    );
    const one = [
      draft("pub", { marketing: true, support: false, publicUse: true }),
    ];
    const s = Array.from({ length: 12 }, (_, i) =>
      proposal(`p${i}`, { draftId: "pub" }),
    );
    expect(bulkSummary(s, one, {}, de).text).toBe(
      "12 Aussagen · Marketing · 12 öffentlich",
    );
    expect(
      bulkSummary(
        s,
        [draft("pub", { marketing: false, support: true, publicUse: false })],
        {},
        en,
      ).text,
    ).toBe("12 statements · Support · 0 public");
  });

  it("summary for mixed rights", () => {
    const sel = [proposal("a"), proposal("b")];
    const edits = { a: { support: false, publicUse: true } };
    expect(bulkSummary(sel, [], edits, de).text).toBe(
      "2 Aussagen · Marketing 2 · Support 1 · 1 öffentlich",
    );
    expect(bulkSummary(sel, [], edits, en).text).toBe(
      "2 statements · Marketing 2 · Support 1 · 1 public",
    );
  });

  it("summary singular in both languages", () => {
    const sel = [proposal("a")];
    expect(bulkSummary(sel, [], {}, de).text).toBe(
      "1 Aussage · Marketing und Support · 0 öffentlich",
    );
    expect(bulkSummary(sel, [], {}, en).text).toBe(
      "1 statement · Marketing and Support · 0 public",
    );
  });

  it("needsPublicNote when any is internal", () => {
    const pub = draft("pub", {
      marketing: true,
      support: true,
      publicUse: true,
    });
    expect(
      bulkSummary([proposal("a", { draftId: "pub" })], [pub], {}, en)
        .needsPublicNote,
    ).toBe(false);
    expect(
      bulkSummary(
        [proposal("a", { draftId: "pub" }), proposal("b")],
        [pub],
        {},
        en,
      ).needsPublicNote,
    ).toBe(true);
  });

  it("the payload takes the version from the proposal it is given", () => {
    const a = decisionPayload(proposal("a", {}, 3), []);
    const b = decisionPayload(proposal("a", {}, 4), []);
    expect(a.version).toBe(3);
    expect(b.version).toBe(4);
    expect(a).toEqual({
      proposalId: "a",
      version: 3,
      decision: "accept",
      statement: "Statement a",
      publicUse: false,
      audiences: ["marketing", "support"],
    });
  });

  it("the payload carries a card edit", () => {
    const p = decisionPayload(proposal("a"), [], {
      statement: "Mine",
      marketing: false,
      publicUse: true,
    });
    expect(p).toMatchObject({
      statement: "Mine",
      publicUse: true,
      audiences: ["support"],
    });
  });

  it("the statement is trimmed", () => {
    expect(
      decisionPayload(proposal("a"), [], { statement: "  Hello \n" }).statement,
    ).toBe("Hello");
  });

  it("confirmAll sends one at a time in order", async () => {
    const log: string[] = [];
    const release: Array<() => void> = [];
    const result = confirmAll(
      [{ id: "a" }, { id: "b" }],
      (item) =>
        new Promise<void>((resolve) => {
          log.push(`start ${item.id}`);
          release.push(() => {
            log.push(`end ${item.id}`);
            resolve();
          });
        }),
      () => "X",
    );
    await Promise.resolve();
    expect(log).toEqual(["start a"]);
    release[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["start a", "end a", "start b"]);
    release[1]!();
    expect(await result).toEqual({ done: ["a", "b"], failed: [] });
  });

  it("confirmAll continues after a failure and reports the code", async () => {
    const result = await confirmAll(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (item) => {
        if (item.id === "b") throw new Error("VERSION_CONFLICT");
      },
      (e) => (e as Error).message,
    );
    expect(result).toEqual({
      done: ["a", "c"],
      failed: [{ id: "b", code: "VERSION_CONFLICT" }],
    });
  });

  it("has the result line and new copy in both languages", () => {
    expect(de.bulkResult.replace("{done}", "10").replace("{total}", "12")).toBe(
      "10 von 12 bestätigt",
    );
    expect(en.bulkResult.replace("{done}", "10").replace("{total}", "12")).toBe(
      "10 of 12 confirmed",
    );
    expect(de.bulkConfirm).toBe("Auswahl bestätigen");
    expect(en.moreEvidence).toBe("More about the evidence");
  });
});
