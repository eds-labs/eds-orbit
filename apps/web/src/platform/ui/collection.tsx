"use client";
// Shared view helpers of the web platform (WP1.7). Module views import these
// instead of each other, so no module UI depends on another module's files.
import { ArrowRight } from "lucide-react";
import {
  collectionPath,
  useResource,
  value,
  when,
  type Entity,
} from "@/lib/api";
import { Alert, Button, Status } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
export function useCollection(name: string) {
  const { project, revision } = useWorkspace();
  return useResource<{ items: Entity[] }>(
    collectionPath(project.id, `${name}?revision=${revision}`),
  );
}
export function PageHead({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function ResourceError({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  return error ? (
    <Alert kind="error">
      <p>{error.message}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        Try again
      </Button>
    </Alert>
  ) : null;
}
export function EntityRows({
  items,
  fields,
  onSelect,
}: {
  items: Entity[];
  fields: string[];
  onSelect?: (e: Entity) => void;
}) {
  const { locale, project, t } = useWorkspace();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f}>{f.replace(/([A-Z])/g, " $1")}</th>
            ))}
            {onSelect && (
              <th>
                <span className="sr-only">{t("review")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              {fields.map((f, i) => (
                <td key={f}>
                  {f === "status" ? (
                    <Status value={e.data.status} />
                  ) : f === "createdAt" || f === "updatedAt" ? (
                    when(e[f], locale, project.timezone)
                  ) : i === 0 && onSelect ? (
                    <button className="row-button" onClick={() => onSelect(e)}>
                      {value(
                        e,
                        f,
                        f === "title" && e.kind === "insights"
                          ? "Performance insight"
                          : "—",
                      )}
                    </button>
                  ) : (
                    value(e, f)
                  )}
                </td>
              ))}
              {onSelect && (
                <td>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("review")} ${value(e, fields[0])}`}
                    onClick={() => onSelect(e)}
                  >
                    <ArrowRight />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
