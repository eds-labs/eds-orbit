"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Field, FieldGroup, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { AccountPicker } from "./account-picker";
import {
  adsPath, checkAccount, formatMicros, startConnect, unlinkAccount, updateAccount,
  type AdAccountView, type AdsConnectionsView,
} from "./api";
import { accountsMessage, adsText } from "./labels";

// Accounts & connections (ADR 0025, A3). Everybody with the module sees the
// accounts; the owner (ads.accounts.manage) connects, assigns, checks and
// disconnects. Tokens never reach the browser.

const tone = { active: "success", reconnect_required: "warning", disabled: "danger" } as const;
const SOON_MS = 14 * 86_400_000;
const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : "");
type Note = { kind: "success" | "error"; text: string };

function Row({ account, owner, canReconnect, onNote, onUnlink, onReconnect }: {
  account: AdAccountView;
  owner: boolean;
  canReconnect: boolean;
  onNote: (note: Note) => void;
  onUnlink: (account: AdAccountView) => void;
  onReconnect: () => void;
}) {
  const { project, locale, refresh } = useWorkspace();
  const t = adsText(locale).accounts;
  const [dsa, setDsa] = useState(account.settings);
  const expires = account.connection?.tokenExpiresAt ?? null;
  const soon = expires !== null && Date.parse(expires) - Date.now() < SOON_MS;
  const providerWord = account.providerStatus ? (t.providerStatus[account.providerStatus.split(":")[0]!] ?? t.providerStatusOther) : null;
  const code = account.health.lastErrorCode;
  const writeReady = account.status === "active" && (account.capability === "write_ready" || account.capability === "write_verified");
  const money = (v: string | null) => formatMicros(v, account.currency, locale);
  const run = async (work: () => Promise<Note>) => {
    try {
      onNote(await work());
    } catch (e) {
      onNote({ kind: "error", text: accountsMessage(codeOf(e), locale) });
    }
    refresh();
  };
  const idPrefix = `account-${account.id}`;
  return (
    <li className="work-settings-row">
      <div>
        <strong>{account.name}</strong> <code>{account.externalId}</code>{" "}
        <Badge tone={tone[account.status as keyof typeof tone] ?? "neutral"}>{t.status[account.status] ?? account.status}</Badge>{" "}
        <Badge tone={account.capability === "write_verified" ? "success" : "neutral"}>{t.capability[account.capability] ?? account.capability}</Badge>
        <p className="field-hint">
          {account.currency} · {account.timezone}
          {providerWord ? ` · ${t.meta.status}: ${providerWord}` : ""}
        </p>
        <p className="field-hint">
          {t.meta.spendCap}: {money(account.spendCapMicros)} · {t.meta.spent}: {money(account.amountSpentMicros)}
        </p>
        <p className="field-hint">
          {t.tokenExpires}:{" "}
          {expires ? new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", { dateStyle: "medium", timeZone: project.timezone }).format(new Date(expires)) : t.noExpiry}
        </p>
        {soon && <Alert kind="warning">{t.expiresSoon}</Alert>}
        <p className="field-hint">
          {t.lastCheck}:{" "}
          {account.health.lastCheckedAt ? new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: project.timezone }).format(new Date(account.health.lastCheckedAt)) : t.never}
          {code ? ` · ${t.checkCodes[code] ?? t.genericError}` : ""}
        </p>
      </div>
      {owner && (
        <div>
          <Button variant="outline" size="sm" onClick={() => run(async () => {
            const r = await checkAccount(project.id, account.id);
            return r.ok ? { kind: "success", text: t.checkOk } : { kind: "error", text: t.checkCodes[r.code ?? ""] ?? t.genericError };
          })}>{t.check}</Button>{" "}
          {canReconnect && <Button variant="outline" size="sm" onClick={onReconnect}>{t.reconnect}</Button>}{" "}
          <Button variant="outline" size="sm" onClick={() => onUnlink(account)}>{t.unlink}</Button>
          <p>
            <label>
              <input
                type="checkbox"
                checked={account.writesEnabled}
                disabled={!writeReady && !account.writesEnabled}
                onChange={(e) => run(async () => {
                  await updateAccount(project.id, account, { writesEnabled: e.target.checked });
                  return { kind: "success", text: t.saved };
                })}
              />{" "}
              {t.writes}
            </label>
            <span className="field-hint"> {t.writesNote}</span>
          </p>
          <form onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await updateAccount(project.id, account, { settings: dsa });
              return { kind: "success", text: t.saved };
            });
          }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-beneficiary`}>{t.dsaBeneficiary}</FieldLabel>
                <Input id={`${idPrefix}-beneficiary`} maxLength={200} value={dsa.dsaBeneficiary ?? ""} onChange={(e) => setDsa({ ...dsa, dsaBeneficiary: e.target.value || null })} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-payor`}>{t.dsaPayor}</FieldLabel>
                <Input id={`${idPrefix}-payor`} maxLength={200} value={dsa.dsaPayor ?? ""} onChange={(e) => setDsa({ ...dsa, dsaPayor: e.target.value || null })} />
              </Field>
            </FieldGroup>
            <p className="field-hint">{t.dsaHint}</p>
            <Button type="submit" size="sm">{t.save}</Button>
          </form>
        </div>
      )}
    </li>
  );
}

export function AdsAccounts() {
  const { project, locale, isOwner, refresh } = useWorkspace();
  const t = adsText(locale).accounts;
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const accounts = useResource<{ accounts: AdAccountView[] }>(adsPath(project.id, "/accounts"));
  // Editors may not read the connections (403): only the owner asks.
  const connections = useResource<AdsConnectionsView>(isOwner ? adsPath(project.id, "/connections") : null);
  const [note, setNote] = useState<Note | null>(() => {
    const failed = params.get("error");
    return failed ? { kind: "error", text: accountsMessage(failed, locale) } : null;
  });
  const [picking, setPicking] = useState<string | null>(() => (isOwner ? params.get("connection") : null));
  const [unlinking, setUnlinking] = useState<AdAccountView | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The provider's return parameters are consumed once: take them off the address.
  useEffect(() => {
    if (!params.has("error") && !params.has("connection")) return;
    const rest = new URLSearchParams(params.toString());
    rest.delete("error");
    rest.delete("connection");
    router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A page restored from the cache after the provider's login works again.
  useEffect(() => {
    const reset = () => setConnecting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const connect = async () => {
    setNote(null);
    setConnecting(true);
    try {
      await startConnect(project.id, (url) => window.location.assign(url));
    } catch (e) {
      setConnecting(false);
      setNote({ kind: "error", text: accountsMessage(codeOf(e), locale) });
    }
  };
  const app = connections.data?.app;
  const list = accounts.data?.accounts ?? [];
  const first = connections.data?.connections[0];
  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro}>
        {isOwner && app === "ready" && (
          <>
            <Button onClick={connect} disabled={connecting}>{connecting ? t.connecting : t.connect}</Button>{" "}
            {first && <Button variant="outline" onClick={() => setPicking(first.id)}>{t.selectAccounts}</Button>}
          </>
        )}
      </PageHead>
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
      {isOwner && app && app !== "ready" && <Alert kind="warning">{t.hints[app]}</Alert>}
      <ResourceError error={accounts.error} retry={accounts.refresh} />
      {accounts.data && (list.length ? (
        <ul className="settings-rows">
          {list.map((a) => (
            <Row key={a.id} account={a} owner={isOwner} canReconnect={app === "ready"} onNote={(n) => { setNote(n); accounts.refresh(); }} onUnlink={setUnlinking} onReconnect={connect} />
          ))}
        </ul>
      ) : (
        <Empty title={t.empty} />
      ))}
      {picking && <AccountPicker connectionId={picking} onClose={() => setPicking(null)} onAssigned={() => { accounts.refresh(); connections.refresh(); refresh(); }} />}
      {unlinking && (
        <Modal title={t.unlinkTitle(unlinking.name)} description={t.unlinkBody} onClose={() => setUnlinking(null)}>
          <Button variant="outline" onClick={() => setUnlinking(null)}>{t.cancel}</Button>{" "}
          <Button variant="destructive" onClick={async () => {
            const target = unlinking;
            setUnlinking(null);
            try {
              await unlinkAccount(project.id, target);
            } catch (e) {
              setNote({ kind: "error", text: accountsMessage(codeOf(e), locale) });
            }
            accounts.refresh();
            connections.refresh();
          }}>{t.unlink}</Button>
        </Modal>
      )}
    </div>
  );
}
