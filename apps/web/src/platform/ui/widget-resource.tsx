"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Alert, Button, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useResource } from "@/lib/api";
import { widgetText } from "@/platform/shell/home-widget-text";
import { HomeCard } from "./home-card";

export function WidgetResource<T>({
  id,
  title,
  href,
  path,
  children,
}: {
  id: string;
  title: string;
  href: string;
  path: string;
  children: (data: T) => ReactNode;
}) {
  const { locale, revision } = useWorkspace();
  const text = widgetText(locale);
  const { data, error, refresh, path: loadedPath } = useResource<T>(path);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision;
      refresh();
    }
  }, [revision, refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  if (error?.status === 403 || error?.status === 404) return null;
  return (
    <HomeCard id={id} title={title} href={href}>
      {error ? (
        <Alert kind="error">
          <p>{text.unavailable}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            {text.retry}
          </Button>
        </Alert>
      ) : data && loadedPath === path ? (
        children(data)
      ) : (
        <Skeleton />
      )}
    </HomeCard>
  );
}
