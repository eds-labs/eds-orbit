import { describe, expect, it } from "vitest";
import { editorReducer, effectiveMedia, effectiveText, emptyEditor, toPostInput } from "./editor-state";
import type { PostView } from "../api";

// The editor's state (S4): a base text and images every selected account
// inherits until it gets its own.

const start = () =>
  [
    { type: "baseText", text: "We are live." },
    { type: "toggleAccount", accountId: "x" },
    { type: "toggleAccount", accountId: "tg" },
  ].reduce((s, a) => editorReducer(s, a as never), emptyEditor());

describe("editorReducer", () => {
  it("passes the base text to inheriting accounts only", () => {
    let s = editorReducer(start(), { type: "override", accountId: "x", text: "Live on X." });
    s = editorReducer(s, { type: "baseText", text: "We are live today." });
    expect(effectiveText(s, "tg")).toBe("We are live today.");
    expect(effectiveText(s, "x")).toBe("Live on X.");
    expect(s.dirty).toBe(true);
  });

  it("restores inheritance and forgets an account's own text when it is removed", () => {
    let s = editorReducer(start(), { type: "override", accountId: "x", text: "Live on X." });
    s = editorReducer(s, { type: "inherit", accountId: "x" });
    expect(effectiveText(s, "x")).toBe("We are live.");
    s = editorReducer(s, { type: "override", accountId: "x", text: "Again." });
    s = editorReducer(s, { type: "toggleAccount", accountId: "x" });
    expect(s.accounts).toEqual(["tg"]);
    s = editorReducer(s, { type: "toggleAccount", accountId: "x" });
    expect(effectiveText(s, "x")).toBe("We are live.");
  });

  it("keeps base and own images apart", () => {
    let s = editorReducer(start(), { type: "media", target: "base", mediaIds: ["m1", "m2"] });
    s = editorReducer(s, { type: "media", target: "x", mediaIds: ["m2"] });
    expect(effectiveMedia(s, "tg")).toEqual(["m1", "m2"]);
    expect(effectiveMedia(s, "x")).toEqual(["m2"]);
    s = editorReducer(s, { type: "inherit", accountId: "x", field: "media" });
    expect(effectiveMedia(s, "x")).toEqual(["m1", "m2"]);
  });

  it("sends null for what an account inherits", () => {
    const s = editorReducer(start(), { type: "override", accountId: "x", text: "Live on X." });
    expect(toPostInput(s)).toEqual({
      title: null,
      baseText: "We are live.",
      baseMedia: [],
      variants: [
        { accountId: "x", text: "Live on X.", media: null, options: {} },
        { accountId: "tg", text: null, media: null, options: {} },
      ],
    });
  });

  it("loads a stored post, own texts and images included", () => {
    const post = {
      id: "p1",
      title: "Launch",
      baseText: "Base",
      baseMedia: [{ mediaId: "m1", width: 1, height: 1, altText: null }],
      version: 4,
      variants: [
        { accountId: "x", body: "Own", inheritsText: false, inheritsMedia: false, media: [], options: { replySettings: "following" } },
        { accountId: "tg", body: "Base", inheritsText: true, inheritsMedia: true, media: [{ mediaId: "m1" }], options: {} },
      ],
    } as unknown as PostView;
    const s = editorReducer(emptyEditor(), { type: "load", post });
    expect(s).toMatchObject({ title: "Launch", baseText: "Base", baseMedia: ["m1"], accounts: ["x", "tg"], version: 4, dirty: false });
    expect(effectiveText(s, "x")).toBe("Own");
    expect(effectiveMedia(s, "x")).toEqual([]);
    expect(toPostInput(s).variants[0]).toEqual({ accountId: "x", text: "Own", media: [], options: { replySettings: "following" } });
  });

  it("switches tabs and falls back to the base when the tab's account is removed", () => {
    let s = editorReducer(start(), { type: "tab", tab: "x" });
    expect(s.tab).toBe("x");
    s = editorReducer(s, { type: "toggleAccount", accountId: "x" });
    expect(s.tab).toBe("base");
  });
});
