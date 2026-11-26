import { describe, expect, it } from "vitest";
import { relocateEvidence } from "../src/modules/knowledge/evidence-refresh.ts";

const file = (text: string, path = "docs/plans.md") => ({
  text,
  path,
  hash: text,
});
const quote = "Family chat is included in Premium.";
const old = file(`# Plans\n\n## Premium\n\n${quote}\n\nFooter`);
const citation = { startLine: 5, endLine: 5, quote };

describe("relocating an approved knowledge excerpt", () => {
  it("locates the exact paragraph after unrelated edits and line movement", () => {
    const next = file(
      `# Plans\n\nNew introduction\n\n## Premium\n\n${quote}\n\nChanged footer`,
    );
    expect(relocateEvidence(old, next, citation)).toEqual({
      startLine: 7,
      endLine: 7,
    });
  });

  it("requires a new review for a quote moved into a fenced sample", () => {
    const next = file(
      ["# Plans", "", "## Premium", "", "```text", "", quote, "", "```"].join(
        "\n",
      ),
    );
    expect(relocateEvidence(old, next, citation)).toBeNull();
  });

  it("requires a unique quote in the original snapshot as well", () => {
    const duplicate = file(old.text + "\n\n" + quote);
    expect(relocateEvidence(duplicate, old, citation)).toBeNull();
  });

  it.each([
    file(old.text.replace("included", "removed")),
    file(old.text.replace("## Premium", "## Legacy plan")),
    file(old.text.replace(quote, `${quote}\nOnly until Friday.`)),
    file(`${old.text}\n\n${quote}`),
    file(old.text, "docs/new-plans.md"),
  ])("requires review for missing, changed or ambiguous evidence", (next) => {
    expect(relocateEvidence(old, next, citation)).toBeNull();
  });
});
