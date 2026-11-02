"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/api";
import { Badge, Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  socialPath,
  type PostList,
  type PostSchedule,
  type PostView,
  type SocialAccounts,
  type SocialMediaList,
} from "../api";
import { socialText } from "../labels";
import { PostEditor } from "./editor";
import { Preview } from "./preview";

// The posts of the project (ADR 0020, S4): a list, and the editor for one
// post (`?post=<id>`) or a new one (`?new=1`). The calendar is S6.

const when = (schedule: PostSchedule, notPlanned: string) =>
  schedule.local ? `${schedule.local.replace("T", " ")} (${schedule.timeZone})` : notPlanned;

function PostListView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = socialText(locale).posts;
  const list = useResource<PostList>(socialPath(project.id, "/posts"));
  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro}>
        {canEdit && (
          <a className="button button-primary" href="?new=1">
            {t.newPost}
          </a>
        )}
      </PageHead>
      <ResourceError error={list.error} retry={list.refresh} />
      {list.data &&
        (list.data.items.length ? (
          <ul className="settings-rows">
            {list.data.items.map((item) => (
              <li key={item.id} className="work-settings-row">
                <div>
                  <a href={`?post=${item.id}`}>
                    <strong>{item.title || item.excerpt || item.id}</strong>
                  </a>{" "}
                  <Badge>{t.status[item.status]}</Badge>{" "}
                  {t.approval[item.approvalState] && <span className="field-hint">{t.approval[item.approvalState]}</span>}
                  <p className="field-hint">
                    {when(item.schedule, t.notPlanned)} · {item.accounts.map((a) => a.handle).join(", ")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t.empty} />
        ))}
    </div>
  );
}

/** A post for members who read only: how it will look per account. */
function PostSummary({ post }: { post: PostView }) {
  const { project, locale } = useWorkspace();
  const t = socialText(locale).posts;
  return (
    <div>
      <p>
        <Badge>{t.status[post.status]}</Badge> {when(post.schedule, t.notPlanned)}
      </p>
      <p className="field-hint">{t.readOnly}</p>
      {post.variants.map((v) => (
        <Preview
          key={v.id}
          projectId={project.id}
          platform={v.platform}
          handle={v.handle}
          text={v.body}
          media={v.media}
          locale={locale}
        />
      ))}
    </div>
  );
}

/**
 * Which editor to show: keyed by how the page was opened, so the editor of
 * a new post stays mounted (and finishes its schedule request) when its
 * first save puts `?post=<id>` into the address.
 */
export function editorFrame(
  openedAs: string,
  postId: string | null,
  loaded: { post: boolean; accounts: boolean; library: boolean },
): { key: string; ready: boolean } {
  const ready = (openedAs === "new" || (postId !== null && loaded.post)) && loaded.accounts && loaded.library;
  return { key: openedAs, ready };
}

function PostPage({ postId }: { postId: string | null }) {
  const { project, locale, canEdit } = useWorkspace();
  const t = socialText(locale).posts;
  const router = useRouter();
  const pathname = usePathname();
  const post = useResource<PostView>(postId ? socialPath(project.id, `/posts/${postId}`) : null);
  const accounts = useResource<SocialAccounts>(socialPath(project.id, "/accounts"));
  const library = useResource<SocialMediaList>(socialPath(project.id, "/media"));
  const [openedAs] = useState(postId ?? "new");
  const frame = editorFrame(openedAs, postId, {
    post: Boolean(post.data),
    accounts: Boolean(accounts.data),
    library: Boolean(library.data),
  });
  const title = postId ? post.data?.title || t.title : t.newPost;
  return (
    <div className="support-page">
      <PageHead title={title} description={t.intro}>
        <a className="button button-outline" href="?">
          {t.back}
        </a>
      </PageHead>
      <ResourceError error={post.error ?? accounts.error ?? library.error} retry={() => (post.refresh(), accounts.refresh(), library.refresh())} />
      {frame.ready &&
        (canEdit && !post.data?.readOnly ? (
          <PostEditor
            key={frame.key}
            post={openedAs === "new" ? null : (post.data ?? null)}
            accounts={accounts.data!.items}
            library={library.data!.items}
            onSaved={(saved) => {
              if (!postId) router.replace(`${pathname}?post=${saved.id}`);
            }}
          />
        ) : (
          post.data && <PostSummary post={post.data} />
        ))}
    </div>
  );
}

export function PostsView() {
  const params = useSearchParams();
  const postId = params?.get("post") ?? null;
  if (postId || params?.get("new") === "1") return <PostPage postId={postId} />;
  return <PostListView />;
}
