"use client";
// One card of the project home's grid (UI restructure §5.2): a panel headed
// by its title and a link to the module's overview ("Go to overview →").
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { cn } from "@/lib/utils";
import { AppLink } from "./app-link";

export function HomeCard({
  id,
  title,
  href,
  linkLabel,
  className,
  children,
}: {
  /** Unique on the page: the heading's id. */
  id: string;
  title: string;
  /** The overview the card leads to. */
  href: string;
  /** Defaults to "Go to overview". */
  linkLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useWorkspace();
  return (
    <section className={cn("panel home-card", className)} aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        <AppLink className="text-link home-card-link" href={href}>
          {linkLabel ?? t("toOverview")}
          <ArrowRight aria-hidden />
        </AppLink>
      </div>
      <div className="home-card-body">{children}</div>
    </section>
  );
}
