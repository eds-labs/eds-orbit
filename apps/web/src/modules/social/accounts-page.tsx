"use client";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { manageHref } from "@/platform/settings-center/routes";
import { AccountsSummaryView } from "./accounts";
import { socialPath, type SocialAccounts } from "./api";

/**
 * Where the OAuth callback's return goes, as the settings center manages the
 * accounts: the callback only accepts a return below the module, so the result
 * arrives on the module page and is passed on, unchanged, to the section with
 * the editor. Null: show the page as it is.
 */
export function socialReturnTarget(projectId: string, search: string): string | null {
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
 * The module's accounts page. The editor lives only in the center; this page
 * states the accounts and links there.
 */
export function SocialAccountsPage() {
  const { project } = useWorkspace();
  const router = useRouter();
  const search = useSearchParams()?.toString() ?? "";
  const target = socialReturnTarget(project.id, search ? `?${search}` : "");
  const forwarded = useRef(false);
  useEffect(() => {
    if (!target || forwarded.current) return;
    forwarded.current = true;
    router.replace(target);
  }, [target, router]);
  // Never the editor while the result is on its way to the center.
  if (target) return null;
  return <AccountsSummaryPage />;
}
