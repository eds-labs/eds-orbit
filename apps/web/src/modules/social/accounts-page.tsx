"use client";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { manageHref } from "@/platform/settings-center/routes";
import { AccountsSummaryView, AccountsView } from "./accounts";
import { socialPath, type SocialAccounts } from "./api";

/**
 * Where the OAuth callback's return goes once the settings center manages the
 * accounts: the callback only accepts a return below the module, so the result
 * arrives on the module page and is passed on, unchanged, to the section with
 * the editor. Null: show the page as it is.
 */
export function socialReturnTarget(
  stage: "off" | "preview" | "on" | undefined,
  projectId: string,
  search: string,
): string | null {
  if (stage !== "on") return null;
  const params = new URLSearchParams(search);
  if (!params.has("connected") && !params.has("error")) return null;
  return manageHref({ kind: "project", projectId }, "integrations", "social", "accounts") + search;
}

function AccountsSummaryPage() {
  const { project, locale } = useWorkspace();
  const accounts = useResource<SocialAccounts>(socialPath(project.id, "/accounts"));
  return (
    <AccountsSummaryView
      accounts={accounts.data?.items ?? null}
      locale={locale}
      manageHref={manageHref({ kind: "project", projectId: project.id }, "integrations", "social", "accounts")}
      notice={<ResourceError error={accounts.error} retry={accounts.refresh} />}
    />
  );
}

/**
 * The module's accounts page. With the center off or in preview it is the
 * editor as before; with it on, the editor lives only in the center and this
 * page states the accounts and links there.
 */
export function SocialAccountsPage() {
  const { project, identity } = useWorkspace();
  const stage = identity?.settingsCenter;
  const router = useRouter();
  const search = useSearchParams()?.toString() ?? "";
  const target = socialReturnTarget(stage, project.id, search ? `?${search}` : "");
  const forwarded = useRef(false);
  useEffect(() => {
    if (!target || forwarded.current) return;
    forwarded.current = true;
    router.replace(target);
  }, [target, router]);
  if (stage !== "on") return <AccountsView />;
  // Never the editor while the result is on its way to the center.
  if (target) return null;
  return <AccountsSummaryPage />;
}
