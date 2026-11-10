"use client";
import { Hourglass } from "lucide-react";
import { Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { socialText } from "./labels";

/** The views of later phases (calendar, posts, media, accounts, analytics). */
export function SocialPlaceholder() {
  const { locale } = useWorkspace();
  const t = socialText(locale);
  return (
    <div className="support-page">
      <Empty icon={Hourglass} title={t.later} description={t.laterBody} />
    </div>
  );
}
