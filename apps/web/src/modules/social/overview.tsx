"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { socialPath, type SocialStatus } from "./api";
import { socialText } from "./labels";

// The social module's overview (ADR 0020, S1): what the module is and the
// project's approval policy, as the server reports it.

export function SocialOverview() {
  const { project, locale, t: word } = useWorkspace();
  const t = socialText(locale);
  const status = useResource<SocialStatus>(socialPath(project.id, "/status"));
  return (
    <div className="support-page">
      <PageHead title={t.module} description={t.intro} eyebrow={word("moduleEyebrow")} />
      <ResourceError error={status.error} retry={status.refresh} />
      {status.data && (
        <section aria-labelledby="social-approval">
          <h2 id="social-approval">{t.approvalTitle}</h2>
          <p>{t.approval[status.data.settings.approval]}</p>
        </section>
      )}
    </div>
  );
}
