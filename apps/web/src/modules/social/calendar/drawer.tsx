"use client";
import { useResource } from "@/lib/api";
import { Badge, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { useShell } from "@/platform/shell/shell-context";
import { projectHref } from "@/platform/shell/routes";
import { socialPath, type CalendarItem, type PostView } from "../api";
import { socialText } from "../labels";
import { Preview } from "../posts/preview";
import { Publications } from "../posts/publications";
import { PostMetricsSection } from "../analytics";
import { localOf } from "./grid";
import { moveCheck } from "./move";
import { OriginNote } from "../origin";

// A post opened from the calendar (S6): its time, status, approval, how it
// looks per account, its deliveries, and the way to the editor or to
// "Move to…". Another project's post (organization scope) is read-only here.

export function PostDrawer({
  item,
  scope,
  onClose,
  onMove,
}: {
  item: CalendarItem;
  scope: "project" | "organization";
  onClose: () => void;
  onMove: (item: CalendarItem) => void;
}) {
  const { project, locale, isOwner, canEdit } = useWorkspace();
  const shell = useShell();
  const all = socialText(locale);
  const t = all.calendar;
  const detail = useResource<PostView>(
    socialPath(item.projectId, `/posts/${item.id}`),
  );
  const post = detail.data;
  // The loaded post is fresher than the calendar's copy.
  const current: CalendarItem = post
    ? {
        ...item,
        status: post.status,
        readOnly: post.readOnly,
        origin: post.origin,
        originRef: post.originRef ?? item.originRef,
        version: post.version,
        schedule: post.schedule,
        approvalState: post.approval.state,
      }
    : item;
  const own = item.projectId === project.id;
  const role = isOwner ? "owner" : canEdit ? "editor" : "viewer";
  const check = moveCheck(
    current,
    role,
    scope === "organization" && !own ? "organization" : "project",
  );
  const route = shell.table?.routes.find((r) => r.key === "social.posts");
  const editorHref = own
    ? `${shell.hrefOf("social.posts")}?post=${encodeURIComponent(item.id)}`
    : route
      ? `${projectHref(item.projectId, route)}?post=${encodeURIComponent(item.id)}`
      : null;
  const at = current.schedule.at;
  return (
    <Modal
      title={item.title || item.excerpt || all.posts.title}
      onClose={onClose}
      wide
    >
      <div className="cal-drawer">
        {!own && item.projectName && (
          <p>
            <strong>{item.projectName}</strong>
          </p>
        )}
        {at && (
          <p>
            {localOf(at, project.timezone).replace("T", " ")} (
            {project.timezone})
          </p>
        )}
        {current.schedule.local &&
          current.schedule.timeZone !== project.timezone && (
            <p className="field-hint">
              {t.ownZone(
                current.schedule.local.replace("T", " "),
                current.schedule.timeZone,
              )}
            </p>
          )}
        <p>
          <Badge>{all.posts.status[current.status]}</Badge>{" "}
          <OriginNote post={current} locale={locale} />
        </p>
        {!own && <p className="field-hint">{t.otherProject}</p>}
        <div className="button-row">
          {editorHref && (
            <a className="button button-outline" href={editorHref}>
              {own ? t.openEditor : t.openProject}
            </a>
          )}
          {post && check.kind !== "forbidden" && (
            <Button onClick={() => onMove(current)}>{t.moveTo}</Button>
          )}
        </div>
        <ResourceError error={detail.error} retry={detail.refresh} />
        {post && own && <Publications post={post} onChanged={detail.refresh} />}
        {post && own && ["published", "partially_published"].includes(post.status) && (
          <PostMetricsSection projectId={item.projectId} postId={item.id} locale={locale} />
        )}
        {!own && item.publications.total > 0 && (
          <p className="field-hint">
            {t.publicationsSummary(
              item.publications.published,
              item.publications.total,
            )}
          </p>
        )}
        {post?.variants.map((v) => (
          <Preview
            key={v.id}
            projectId={item.projectId}
            platform={v.platform}
            handle={v.handle}
            text={v.body}
            media={v.media}
            locale={locale}
          />
        ))}
      </div>
    </Modal>
  );
}
