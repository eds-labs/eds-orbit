import { describe, expect, it } from "vitest";
import { jsonOf } from "../src/platform/agents/structured-run.ts";

// An answer that only had its schema in the instructions (Anthropic's
// "compiled grammar is too large" path) may wrap the object.
describe("the JSON object of a structured answer", () => {
  it("takes the object as it is, out of a code fence or out of a sentence", () => {
    expect(jsonOf('{"a":1}')).toBe('{"a":1}');
    expect(jsonOf('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonOf('Here is the plan:\n{"a":{"b":2}}\nDone.')).toBe('{"a":{"b":2}}');
    expect(jsonOf("no object")).toBe("no object");
  });
});
