"use client";
import { Hourglass } from "lucide-react";
import { Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { adsText } from "./labels";
import { PageHead } from "@/platform/ui/collection";

/** The views of later phases (campaigns, ads, creatives, performance, accounts). */
export function AdsPlaceholder({
  section,
}: {
  section: "campaigns" | "units" | "creatives" | "performance";
}) {
  const { locale } = useWorkspace();
  const t = adsText(locale);
  return (
    <div className="support-page">
      <PageHead title={t.nav[section]} description={t.laterBody} />
      <Empty icon={Hourglass} title={t.later} />
    </div>
  );
}
