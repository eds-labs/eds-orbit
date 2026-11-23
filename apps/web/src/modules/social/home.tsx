"use client";

import { useState } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { when } from "@/lib/api";
import { useShell } from "@/platform/shell/shell-context";
import { WidgetResource } from "@/platform/ui/widget-resource";
import { socialPath, type CalendarResponse } from "./api";

export function SocialHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const [query] = useState(() => {
    const now = Date.now();
    return new URLSearchParams({
      from: new Date(now).toISOString(),
      to: new Date(now + 7 * 86_400_000).toISOString(),
      statuses: "scheduled",
    });
  });
  return (
    <WidgetResource<CalendarResponse>
      id="home-card-social"
      title={de ? "Geplante Social-Beiträge" : "Scheduled social posts"}
      href={shell.hrefOf("social.calendar")}
      path={socialPath(project.id, `/calendar?${query}`)}
    >
      {({ items }) => {
        const next = items
          .filter(
            ({ schedule }) =>
              schedule.at && Date.parse(schedule.at) >= Date.now(),
          )
          .slice(0, 3);
        return next.length ? (
          <ul className="home-widget-rows">
            {next.map((item) => (
              <li key={item.id}>
                <strong>
                  {item.title || (de ? "Beitrag ohne Titel" : "Untitled post")}
                </strong>
                <span>{when(item.schedule.at!, locale, project.timezone)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            {de
              ? "Keine geplanten Beiträge in den nächsten sieben Tagen."
              : "No posts scheduled in the next seven days."}
          </p>
        );
      }}
    </WidgetResource>
  );
}
