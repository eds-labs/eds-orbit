import type { PostInput, PostView } from "../api";

// The post editor's state (ADR 0020, S4): one base text and image set that
// every selected account inherits until it gets its own. `null` in an
// override means "inherit"; the server stores the same distinction.

export type Override = { text: string | null; media: string[] | null; options: Record<string, unknown> };
export type EditorState = {
  title: string;
  baseText: string;
  baseMedia: string[];
  accounts: string[];
  overrides: Record<string, Override>;
  /** "base" or an account id. */
  tab: string;
  version: number | null;
  dirty: boolean;
};
export type EditorAction =
  | { type: "load"; post: PostView }
  | { type: "title"; title: string }
  | { type: "baseText"; text: string }
  | { type: "toggleAccount"; accountId: string }
  | { type: "override"; accountId: string; text: string }
  | { type: "inherit"; accountId: string; field?: "text" | "media" }
  | { type: "media"; target: string; mediaIds: string[] }
  | { type: "tab"; tab: string };

export const emptyEditor = (): EditorState => ({
  title: "",
  baseText: "",
  baseMedia: [],
  accounts: [],
  overrides: {},
  tab: "base",
  version: null,
  dirty: false,
});

const blank = (): Override => ({ text: null, media: null, options: {} });

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const touched = (next: Partial<EditorState>): EditorState => ({ ...state, ...next, dirty: true });
  const override = (accountId: string, change: Partial<Override>) => ({
    ...state.overrides,
    [accountId]: { ...(state.overrides[accountId] ?? blank()), ...change },
  });
  switch (action.type) {
    case "load":
      return {
        title: action.post.title ?? "",
        baseText: action.post.baseText,
        baseMedia: action.post.baseMedia.map((m) => m.mediaId),
        accounts: action.post.variants.map((v) => v.accountId),
        overrides: Object.fromEntries(
          action.post.variants.map((v) => [
            v.accountId,
            {
              text: v.inheritsText ? null : v.body,
              media: v.inheritsMedia ? null : v.media.map((m) => m.mediaId),
              options: v.options,
            },
          ]),
        ),
        tab: state.tab === "base" || action.post.variants.some((v) => v.accountId === state.tab) ? state.tab : "base",
        version: action.post.version,
        dirty: false,
      };
    case "title":
      return touched({ title: action.title });
    case "baseText":
      return touched({ baseText: action.text });
    case "toggleAccount": {
      if (state.accounts.includes(action.accountId)) {
        const { [action.accountId]: _gone, ...overrides } = state.overrides;
        return touched({
          accounts: state.accounts.filter((id) => id !== action.accountId),
          overrides,
          tab: state.tab === action.accountId ? "base" : state.tab,
        });
      }
      return touched({ accounts: [...state.accounts, action.accountId] });
    }
    case "override":
      return touched({ overrides: override(action.accountId, { text: action.text }) });
    case "inherit":
      return touched({
        overrides: override(
          action.accountId,
          action.field === "media" ? { media: null } : action.field === "text" ? { text: null } : { text: null, media: null },
        ),
      });
    case "media":
      return action.target === "base"
        ? touched({ baseMedia: action.mediaIds })
        : touched({ overrides: override(action.target, { media: action.mediaIds }) });
    case "tab":
      return { ...state, tab: action.tab };
  }
}

/** The text an account will publish. */
export const effectiveText = (state: EditorState, accountId: string) =>
  state.overrides[accountId]?.text ?? state.baseText;

/** The images an account will publish, in order. */
export const effectiveMedia = (state: EditorState, accountId: string) =>
  state.overrides[accountId]?.media ?? state.baseMedia;

/** The request body of POST /posts and PATCH /posts/:postId (without version). */
export function toPostInput(state: EditorState): PostInput {
  return {
    title: state.title.trim() || null,
    baseText: state.baseText,
    baseMedia: state.baseMedia,
    variants: state.accounts.map((accountId) => {
      const o = state.overrides[accountId] ?? blank();
      return { accountId, text: o.text, media: o.media, options: o.options };
    }),
  };
}
