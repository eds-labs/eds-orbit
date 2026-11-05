"use client";
import { useState } from "react";
import { HardDrive } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/api";
import { Alert, Empty } from "@/components/ui/primitives";
import { refreshFailureText } from "@/components/google-drive";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { useShell } from "@/platform/shell/shell-context";
import { settingsSectionHref } from "@/platform/shell/settings-nav";
import { driveFolderParam, drivePaths, type DriveStatus } from "./api";
import { DriveBrowser } from "./drive-browser";
import { driveText } from "./labels";

// The Google Drive page of a project (design 2026-11-05 §5.2). The open
// folder is in `?folder=`, so folders can be linked and back and forward
// move between them. Module actions come from WebModule.drive.

export function DrivePage() {
  const { project, isOwner, locale } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const t = driveText(locale);
  const status = useResource<DriveStatus>(drivePaths(project.id).status);
  const raw = search.get("folder");
  const folderId = driveFolderParam(raw);
  const [ignored] = useState(() => Boolean(raw) && !folderId);
  const settings = settingsSectionHref(shell.hrefOf("settings"), "integrations");

  const head = <PageHead title={t.title} description={t.description} />;
  if (status.error)
    return (
      <>
        {head}
        <ResourceError error={status.error} retry={status.refresh} />
      </>
    );
  if (!status.data) return head;
  const reconnect = status.data.reconnectRequired && (
    <Alert kind="error">
      {t.reconnect}
      {status.data.lastRefreshErrorCode && (
        <p>{refreshFailureText(status.data.lastRefreshErrorCode, locale === "de")}</p>
      )}
      {isOwner && (
        <p>
          <a href={settings}>{t.toSettings}</a>
        </p>
      )}
    </Alert>
  );
  if (!status.data.enabled)
    return (
      <>
        {head}
        {reconnect}
        <Empty icon={HardDrive} title={t.notReadyTitle} description={isOwner ? t.notReadyOwner : t.notReadyMember}>
          {isOwner && <a href={settings}>{t.toSettings}</a>}
        </Empty>
      </>
    );
  return (
    <>
      {head}
      {reconnect}
      {ignored && <Alert kind="warning">{t.outsideRoot}</Alert>}
      <DriveBrowser
        projectId={project.id}
        folderId={folderId}
        onFolderChange={(id) => router.push(id ? `${pathname}?folder=${encodeURIComponent(id)}` : pathname)}
        mode="browse"
        fileActions={shell.drive?.fileActions}
        toolbar={shell.drive?.toolbar}
        root={
          status.data.rootFolderId
            ? { id: status.data.rootFolderId, name: status.data.rootName ?? t.title }
            : undefined
        }
        settingsHref={isOwner ? settings : undefined}
        locale={locale}
      />
    </>
  );
}
