"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResource, when } from "@/lib/api";
import { Badge, Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cn } from "@/lib/utils";
import { financePath, query, type FinanceDocument } from "./api";
import { FinanceDocumentDetail, FlagBadges, SEVERE_FLAGS } from "./document";
import { financeText } from "./labels";

// The review queue (spec §9): every document that waits for a person,
// most severe first, with the open document beside it. The selection and
// the status filter live in the URL (?document=<id>&status=<status>), so
// links from the overview, the home card and attention items open it.

/** Statuses the queue shows when no filter is set. */
const OPEN = ["needs_review", "failed", "duplicate", "received"] as const;
/** Statuses offered as a filter. */
export const FILTERS = ["needs_review", "failed", "duplicate"] as const;
type Filter = (typeof FILTERS)[number];
const LIMIT = 200;

const filterOf = (value: string | null): Filter | null =>
  FILTERS.find((f) => f === value) ?? null;

/** 0 failed, 1 a severe flag or a duplicate, 2 everything else. */
export function severityOf(doc: Pick<FinanceDocument, "status" | "flags">) {
  if (doc.status === "failed") return 0;
  if (doc.status === "duplicate" || doc.flags.some((f) => SEVERE_FLAGS.has(f)))
    return 1;
  return 2;
}

/** The queue order: severity, then oldest first. */
export function sortQueue<
  T extends Pick<FinanceDocument, "status" | "flags" | "createdAt">,
>(docs: readonly T[]): T[] {
  return [...docs].sort(
    (a, b) =>
      severityOf(a) - severityOf(b) || a.createdAt.localeCompare(b.createdAt),
  );
}

/** The documents of the active statuses, merged; one request per status. */
function useQueue(projectId: string, filter: Filter | null) {
  const active: readonly string[] = filter ? [filter] : OPEN;
  // One hook per status in a fixed order; inactive statuses ask for nothing.
  const path = (status: (typeof OPEN)[number]) =>
    active.includes(status)
      ? financePath(projectId, `/documents${query({ status, limit: LIMIT })}`)
      : null;
  type List = { items: FinanceDocument[] };
  const resources = [
    useResource<List>(path("needs_review")),
    useResource<List>(path("failed")),
    useResource<List>(path("duplicate")),
    useResource<List>(path("received")),
  ];
  const used = resources.filter((_, i) => active.includes(OPEN[i]!));
  return {
    items: sortQueue(used.flatMap((r) => r.data?.items ?? [])),
    loading: used.some((r) => r.loading),
    error: used.find((r) => r.error)?.error ?? null,
    refresh: () => used.forEach((r) => r.refresh()),
  };
}

/** The review page: status filter, the sorted queue and the open document. */
export function FinanceReview() {
  const { project, locale, t: word } = useWorkspace();
  const t = financeText(locale);
  const r = t.review;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params?.get("document") ?? null;
  const filter = filterOf(params?.get("status") ?? null);
  const queue = useQueue(project.id, filter);
  const hrefWith = (change: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(change))
      if (value) next.set(key, value);
      else next.delete(key);
    const text = next.toString();
    return `${pathname}${text ? `?${text}` : ""}`;
  };
  const navigate = (change: Record<string, string | null>) =>
    router.replace(hrefWith(change));
  return (
    <>
      <PageHead
        title={r.title}
        description={r.intro}
        eyebrow={word("moduleEyebrow")}
      />
      <div className={cn("finance-review", selected && "finance-review-open")}>
        <section className="panel finance-queue" aria-label={r.queue}>
          <div className="panel-head">
            <h2>{r.queue}</h2>
            <div className="finance-period">
              <label htmlFor="finance-review-status">{r.filter}</label>
              <select
                id="finance-review-status"
                className="input"
                value={filter ?? ""}
                onChange={(e) => navigate({ status: e.target.value || null })}
              >
                <option value="">{r.filterAll}</option>
                {FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {r.statuses[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="finance-body">
            {queue.loading ? (
              <Skeleton />
            ) : queue.error ? (
              <ResourceError error={queue.error} retry={queue.refresh} />
            ) : queue.items.length ? (
              <ul className="settings-rows">
                {queue.items.map((doc) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      className="list-row"
                      aria-current={doc.id === selected ? "true" : undefined}
                      onClick={() => navigate({ document: doc.id })}
                    >
                      <span className="list-row-title">
                        {doc.originalName ?? t.dashboard.unnamedReceipt}
                      </span>
                      <span className="list-row-meta">
                        <Badge
                          tone={doc.status === "failed" ? "danger" : "neutral"}
                        >
                          {r.statuses[doc.status] ?? doc.status}
                        </Badge>{" "}
                        {when(doc.createdAt, locale, project.timezone)}
                      </span>
                      <FlagBadges t={t} flags={doc.flags} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={filter ? r.emptyFiltered : r.empty} />
            )}
          </div>
        </section>
        {selected && (
          <FinanceDocumentDetail
            key={selected}
            documentId={selected}
            hrefOf={(id) => hrefWith({ document: id })}
            onClose={() => navigate({ document: null })}
            onChanged={queue.refresh}
          />
        )}
      </div>
    </>
  );
}
