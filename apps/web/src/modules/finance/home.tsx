"use client";
import { useResource } from "@/lib/api";
import { Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { HomeCard } from "@/platform/ui/home-card";
import { financePath, type SetupStatus } from "./api";
import { financeText } from "./labels";

/**
 * The finance card of the project home. Until the dashboard (Task 19) it
 * links to the overview and says whether the books are set up. Renders
 * nothing while the module answers an error such as 404.
 */
export function FinanceHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = financeText(locale);
  const setup = useResource<SetupStatus>(financePath(project.id, "/setup"));
  if (setup.error) return null;
  return (
    <HomeCard
      id="home-card-finance"
      title={t.finance}
      href={shell.hrefOf("finance")}
    >
      {setup.loading ? (
        <Skeleton />
      ) : (
        <p className="panel-note">
          {setup.data?.ready ? t.financeIntro : t.setup.title}
        </p>
      )}
    </HomeCard>
  );
}
