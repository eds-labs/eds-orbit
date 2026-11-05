"use client";
import { useContext, useState } from "react";
import { api, post, useMutation, useResource } from "@/lib/api";
import { ShellContext } from "@/platform/shell/shell-context";
import { useWorkspace } from "./workspace-context";
import { Alert, Button } from "./ui/primitives";
import { FolderOpen } from "lucide-react";
import type { DriveStatus } from "@/platform/drive/api";

/**
 * What the recorded OAuth error means. `invalid_grant` on a token that
 * worked before is, in practice, the seven-day expiry Google applies to
 * refresh tokens of an OAuth app still in the "Testing" publishing status
 * (or a revoked grant); the fix is in the Google Cloud Console, not in Orbit.
 */
export function refreshFailureText(code: string, de: boolean) {
  if (code === "invalid_grant")
    return de
      ? "Google meldet „invalid_grant“: Der gespeicherte Zugriff ist abgelaufen oder wurde widerrufen. Läuft die Verbindung regelmäßig nach etwa sieben Tagen ab, steht die OAuth-App in der Google Cloud Console noch im Status „Testing“. Dort unter „OAuth consent screen“ auf „In production“ veröffentlichen, dann erneut verbinden; danach laufen die Zugriffe nicht mehr ab."
      : "Google reports “invalid_grant”: the stored access expired or was revoked. If the connection drops about every seven days, the OAuth app in the Google Cloud Console is still in the “Testing” publishing status. Publish it (“OAuth consent screen” → “In production”), then reconnect; access then no longer expires.";
  return de
    ? `Google meldet „${code}“. Prüfe OAuth-Client, Freigabe und Zugriffsrechte des Kontos, dann erneut verbinden.`
    : `Google reports “${code}”. Check the OAuth client, consent and the account's access, then reconnect.`;
}
export function GoogleDriveSettings() {
  const { project, isOwner, locale, refresh } = useWorkspace();
  const base = `/projects/${encodeURIComponent(project.id)}/google-drive`;
  const status = useResource<DriveStatus>(base);
  const [root, setRoot] = useState("");
  const [candidatePage, setCandidatePage] = useState<string | null>(null);
  const [showFolderChooser, setShowFolderChooser] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  // The file browser is the Drive page (design 2026-11-05 §5.4).
  const shell = useContext(ShellContext);
  const candidates = useResource<{
    folders: { id: string; name: string }[];
    nextPageToken: string | null;
  }>(
    status.data?.connected &&
      (!status.data.enabled || showFolderChooser) &&
      isOwner
      ? `${base}/root-candidates${candidatePage ? `?pageToken=${encodeURIComponent(candidatePage)}` : ""}`
      : null,
  );
  const mutation = useMutation(() => {
    status.refresh();
    candidates.refresh();
    refresh();
  });
  const enabled = status.data?.enabled;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Integrations · Google Drive</h2>
          <p>Private project assets and generated media.</p>
        </div>
        <span>
          {status.data?.reconnectRequired
            ? `Reconnect required · ${status.data.account}`
            : status.data?.connected
              ? `Connected · ${status.data.account}`
              : "Disconnected"}
        </span>
      </div>
      {status.error && <Alert kind="error">{status.error.message}</Alert>}
      {status.data?.reconnectRequired && (
        <Alert kind="error">
          {locale === "de"
            ? "Google hat den gespeicherten Drive-Zugriff abgelehnt. Drive-Assets können weder gelesen noch gespeichert werden, bis ein Owner Google Drive erneut verbindet."
            : "Google rejected the stored Drive access. Drive assets cannot be read or saved until an owner reconnects Google Drive."}
          {status.data.lastRefreshErrorCode && (
            <p>
              {refreshFailureText(
                status.data.lastRefreshErrorCode,
                locale === "de",
              )}
            </p>
          )}
        </Alert>
      )}
      {status.data && !status.data.configured && (
        <Alert>
          {locale === "de"
            ? "Google Drive ist noch nicht eingerichtet. Hinterlege die Google OAuth Client-ID und das Secret auf dem Server; danach wird der Button aktiv."
            : "Google Drive is not set up yet. Add the Google OAuth client ID and secret on the server to enable the button."}
        </Alert>
      )}
      {status.data && !isOwner && (
        <Alert>
          {locale === "de"
            ? "Nur Projekteigentümer können Google Drive verbinden."
            : "Only project owners can connect Google Drive."}
        </Alert>
      )}
      <div className="page-actions">
        <Button
          disabled={!isOwner || !status.data?.configured || mutation.pending}
          onClick={() =>
            mutation.run(async () => {
              const result = await post<{ url: string }>(`${base}/connect`, {});
              window.location.assign(result.url);
            })
          }
        >
          {status.data?.connected
            ? locale === "de"
              ? "Google Drive erneut verbinden"
              : "Reconnect"
            : locale === "de"
              ? "Google Drive verbinden"
              : "Connect Google Drive"}
        </Button>
        {isOwner && status.data?.connected && (
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() => mutation.run(() => post(`${base}/disconnect`, {}))}
          >
            Disconnect
          </Button>
        )}
        {isOwner && status.data?.connected && (
          <Button
            variant="outline"
            onClick={() =>
              mutation.run(async () => {
                const result = await api<{
                  healthy: boolean;
                  rootAccessible: boolean;
                }>(`${base}/health`).catch((error) => {
                  status.refresh();
                  throw error;
                });
                setHealth(
                  result.rootAccessible
                    ? "Connection healthy · root accessible"
                    : "Connection healthy · choose a root",
                );
              })
            }
          >
            Test connection
          </Button>
        )}
      </div>
      {health && <Alert>{health}</Alert>}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {status.data?.connected && enabled && isOwner && (
        <Button
          variant="outline"
          onClick={() => setShowFolderChooser(!showFolderChooser)}
        >
          {showFolderChooser
            ? "Close folder selection"
            : "Change project folder"}
        </Button>
      )}
      {status.data?.connected && (!enabled || showFolderChooser) && isOwner && (
        <div>
          <p>
            Select the project folder in Google Drive. Orbit will find the brand
            folders inside it.
          </p>
          {candidates.error && (
            <Alert kind="error">{candidates.error.message}</Alert>
          )}
          <div className="page-actions">
            {candidates.data?.folders.map((candidate) => (
              <Button
                key={candidate.id}
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    api(`${base}/root`, {
                      method: "PUT",
                      body: JSON.stringify({ rootFolderId: candidate.id }),
                    }),
                  )
                }
              >
                <FolderOpen data-icon="inline-start" /> {candidate.name} (
                {candidate.id})
              </Button>
            ))}
            {candidates.data?.nextPageToken && (
              <Button
                variant="outline"
                onClick={() => setCandidatePage(candidates.data!.nextPageToken)}
              >
                More folders
              </Button>
            )}
          </div>
          <details>
            <summary>Enter a folder ID instead</summary>
            <div className="page-actions">
              <input
                aria-label="Drive root folder ID"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
              <Button
                disabled={!root || mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    api(`${base}/root`, {
                      method: "PUT",
                      body: JSON.stringify({ rootFolderId: root }),
                    }),
                  )
                }
              >
                Use folder
              </Button>
            </div>
          </details>
        </div>
      )}
      {enabled && (
        <p>
          <a href={shell?.hrefOf("drive")}>
            {locale === "de" ? "Google Drive öffnen" : "Open Google Drive"}
          </a>
        </p>
      )}
    </section>
  );
}
