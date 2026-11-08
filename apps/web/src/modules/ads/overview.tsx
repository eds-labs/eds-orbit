"use client";
import { Link2 } from "lucide-react";
import { useResource } from "@/lib/api";
import { Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { adsPath, type AdsStatus } from "./api";
import { adsText } from "./labels";

// The ads module's overview (ADR 0025, A1): who decides spend, as the server
// reports it, and the empty state until an account is connected.

export function AdsOverview() {
  const { project, locale, t: word } = useWorkspace();
  const t = adsText(locale);
  const status = useResource<AdsStatus>(adsPath(project.id, "/status"));
  return (
    <div className="support-page">
      <PageHead title={t.module} description={t.intro} eyebrow={word("moduleEyebrow")} />
      <ResourceError error={status.error} retry={status.refresh} />
      {status.data && (
        <>
          <section aria-labelledby="spend-decider">
            <h2 id="spend-decider">{t.deciderTitle}</h2>
            <p>{t.decider}</p>
          </section>
          <Empty icon={Link2} title={t.noAccountTitle} description={t.noAccountBody} />
        </>
      )}
    </div>
  );
}
