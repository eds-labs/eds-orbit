"use client";
import { useResource } from "@/lib/api";
import { Alert, Button, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { useMutation } from "@/lib/api";
import { financeApi, financePath, type SetupStatus } from "./api";
import { financeText, type FinanceText } from "./labels";
import { useFinanceAccess } from "./settings";

/**
 * The setup screen: shown while a system account is missing, with the
 * owner's one-click default chart of accounts.
 */
export function SetupPrompt({
  t,
  missingRoles,
  canSetup,
  pending,
  error,
  onApply,
}: {
  t: FinanceText;
  missingRoles: readonly string[];
  canSetup: boolean;
  pending: boolean;
  error: string | null;
  onApply: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.setup.title}</h2>
          <p>{t.setup.body}</p>
        </div>
      </div>
      {missingRoles.length > 0 && (
        <p className="panel-note">
          {t.setup.missing}:{" "}
          {missingRoles.map((r) => t.roles[r] ?? r).join(", ")}
        </p>
      )}
      {canSetup ? (
        <Button disabled={pending} onClick={onApply}>
          {t.setup.action}
        </Button>
      ) : (
        <p className="panel-note">{t.setup.ownerNeeded}</p>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}

/**
 * The overview. Until the dashboard (Task 19) it is the setup screen and a
 * note that the other pages follow in this release.
 */
export function FinanceOverview() {
  const { project, locale } = useWorkspace();
  const { owner } = useFinanceAccess();
  const t = financeText(locale);
  const setup = useResource<SetupStatus>(financePath(project.id, "/setup"));
  const apply = useMutation(setup.refresh);
  return (
    <>
      <PageHead
        title={t.finance}
        description={t.financeIntro}
        eyebrow={t.finance}
      />
      {setup.loading ? (
        <Skeleton />
      ) : setup.error ? (
        <ResourceError error={setup.error} retry={setup.refresh} />
      ) : setup.data && !setup.data.ready ? (
        <SetupPrompt
          t={t}
          missingRoles={setup.data.missingRoles}
          canSetup={owner}
          pending={apply.pending}
          error={apply.error}
          onApply={() => apply.run(() => financeApi(project.id).setup.apply())}
        />
      ) : (
        <Alert kind="info">{t.overviewComing}</Alert>
      )}
      {apply.success && <Alert kind="success">{t.setup.created}</Alert>}
    </>
  );
}
