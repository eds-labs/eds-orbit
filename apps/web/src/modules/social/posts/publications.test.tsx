import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import type { PostView } from "../api";
import { Publications } from "./publications";

// A post's deliveries (S5): the owner settles an unclear one; history
// mirrored from Postiz (S10) is shown, never settled.

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = { user: { id: "u1", name: "Ada", email: "ada@example.invalid" }, workspaces: [], projects: [project] };
const post = (readOnly: boolean) =>
  ({
    id: "post-1",
    readOnly,
    variants: [{ id: "v1", accountId: "a1", platform: "x", handle: "@orbit_x" }],
    publications: [
      { id: "pub-1", accountId: "a1", platform: "x", status: "outcome_unknown", blockedCode: null, lastErrorCode: null, externalPostId: null, permalink: null, publishedAt: null, resolution: null, test: false, version: 1 },
    ],
  }) as unknown as PostView;
const render = (value: PostView) =>
  renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{ project, identity, locale: "en", t: (k) => labels.en[k], canEdit: true, isOwner: true, revision: 0, refresh: () => {}, href: (p) => p }}
    >
      <Publications post={value} onChanged={() => {}} />
    </WorkspaceContext.Provider>,
  );
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);

describe("social publications", () => {
  it("lets the owner settle an unclear send, but never one mirrored from Postiz", () => {
    expect(buttons(render(post(false)))).toHaveLength(2);
    expect(buttons(render(post(true)))).toEqual([]);
  });
});
