"use client";
import { useState } from "react";
import { ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { adsPath, assignAccount, type AvailableAccounts } from "./api";
import { accountsMessage, adsText } from "./labels";

// The accounts a connection's Meta login reaches (ADR 0025, A3): the owner
// assigns the ones this project may use. Accounts of another project and
// currencies Orbit cannot report on are listed but not selectable.

export function AccountPicker({ connectionId, onClose, onAssigned }: { connectionId: string; onClose: () => void; onAssigned: () => void }) {
  const { project, locale } = useWorkspace();
  const t = adsText(locale).accounts;
  const list = useResource<AvailableAccounts>(adsPath(project.id, `/connections/${encodeURIComponent(connectionId)}/available-accounts`));
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const assign = async (externalId: string) => {
    setBusy(externalId);
    setError(null);
    try {
      await assignAccount(project.id, connectionId, externalId);
      setDone((prev) => new Set([...prev, externalId]));
      onAssigned();
    } catch (e) {
      setError(accountsMessage(e instanceof ApiError ? e.code : "", locale));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title={t.picker.title} description={t.picker.intro} onClose={onClose} wide>
      <ResourceError error={list.error} retry={list.refresh} />
      {!list.data && !list.error && <Loading label={t.loadingPicker} />}
      {error && <Alert kind="error">{error}</Alert>}
      {list.data?.truncated && <Alert kind="info">{t.picker.truncated}</Alert>}
      {list.data && list.data.accounts.length === 0 && <p>{t.picker.none}</p>}
      <ul className="settings-rows">
        {list.data?.accounts.map((a) => {
          const here = a.assigned === "here" || done.has(a.externalId);
          const reason = a.assigned === "elsewhere" ? t.picker.elsewhere : !a.currencySupported ? t.picker.currency : null;
          return (
            <li key={a.externalId} className="work-settings-row">
              <div>
                <strong>{a.name}</strong> <code>{a.externalId}</code> {here && <Badge tone="success">{t.picker.assigned}</Badge>}
                <p className="field-hint">
                  {a.currency} · {a.timezone}
                  {a.businessName ? ` · ${a.businessName}` : ""}
                </p>
                {reason && <p className="field-hint">{reason}</p>}
              </div>
              <Button size="sm" disabled={here || reason !== null || busy !== null} onClick={() => assign(a.externalId)}>
                {t.picker.assign}
              </Button>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" onClick={onClose}>
        {t.picker.close}
      </Button>
    </Modal>
  );
}
