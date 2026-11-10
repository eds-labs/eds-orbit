"use client";
import { Hourglass } from "lucide-react";
import { Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { adsText } from "./labels";

/** The views of later phases (campaigns, ads, creatives, performance, accounts). */
export function AdsPlaceholder() {
  const { locale } = useWorkspace();
  const t = adsText(locale);
  return (
    <div className="support-page">
      <Empty icon={Hourglass} title={t.later} description={t.laterBody} />
    </div>
  );
}
