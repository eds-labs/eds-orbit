"use client";
import Link from "next/link";
import { Compass } from "lucide-react";
import type { Text } from "@/lib/i18n";
import { Button, Empty } from "@/components/ui/primitives";

/** Shown for unknown addresses instead of silently opening another page. */
export function NotFound({
  t,
  project = false,
  homeHref = "/",
}: {
  t: Text;
  /** The address names a project the user cannot open. */
  project?: boolean;
  homeHref?: string;
}) {
  return (
    <div className="not-found">
      <Empty
        icon={Compass}
        title={project ? t("projectNotFound") : t("notFound")}
        description={project ? t("projectNotFoundHint") : t("notFoundHint")}
      >
        <Button asChild variant="outline">
          <Link href={homeHref}>{t("backHome")}</Link>
        </Button>
      </Empty>
    </div>
  );
}
