"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Field, FieldGroup, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { AccountPicker } from "./account-picker";
import {
  adsPath, checkAccount, formatMicros, revokeConnection, startConnect, unlinkAccount, updateAccount,
  type AdAccountView, type AdConnection, type AdsConnectionsView, type AppReadiness,
} from "./api";
import { accountsMessage, adsText, textFor } from "./labels";

// Accounts & connections (ADR 0025, A3). Everybody with the module sees the
// accounts; the owner (ads.accounts.manage) sees the connections, connects,
// assigns, checks, disconnects and revokes. Tokens never reach the browser.

const tone: Record<string, "success" | "warning" | "danger"> = { active: "success", reconnect_required: "warning", disabled: "danger" };
const SOON_MS = 14 * 86_400_000;
const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : "");
type Note = { kind: "success" | "error"; text: string };
/** The accessible name of a per-row control: the action and what it acts on. */
const named = (action: string, name: string) => `${action}: ${name}`;
const soonExpiring = (expires: string | null) => expires !== null && Date.parse(expires) - Date.now() < SOON_MS;
function dateText(value: string, locale: "en" | "de", timeZone: string, withTime = false) {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone }).format(new Date(value));
}

/** What a connection's grant allows, from its granted scopes. */
export function permissionSummary(scopes: readonly string[]): "write" | "read" | "none" {
  if (scopes.includes("ads_management")) return "write";
  return scopes.includes("ads_read") ? "read" : "none";
}

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
  const soon = soonExpiring(expires);
  const providerWord = account.providerStatus ? textFor(t.providerStatus, account.providerStatus.split(":")[0], t.providerStatusOther) : null;
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
        <Badge tone={textFor<"success" | "warning" | "danger" | "neutral">(tone, account.status, "neutral")}>{textFor(t.status, account.status, account.status)}</Badge>{" "}
        <Badge tone={account.capability === "write_verified" ? "success" : "neutral"}>{textFor(t.capability, account.capability, account.capability)}</Badge>
        <p className="field-hint">
          {account.currency} · {account.timezone}
          {providerWord ? ` · ${t.meta.status}: ${providerWord}` : ""}
        </p>
        <p className="field-hint">
          {t.meta.spendCap}: {money(account.spendCapMicros)} · {t.meta.spent}: {money(account.amountSpentMicros)}
        </p>
        <p className="field-hint">
          {t.tokenExpires}: {expires ? dateText(expires, locale, project.timezone) : t.noExpiry}
        </p>
        {soon && <Alert kind="warning">{t.expiresSoon}</Alert>}
        <p className="field-hint">
          {t.lastCheck}: {account.health.lastCheckedAt ? dateText(account.health.lastCheckedAt, locale, project.timezone, true) : t.never}
          {code ? ` · ${textFor(t.checkCodes, code, t.genericError)}` : ""}
        </p>
      </div>
      {owner && (
        <div>
          <Button variant="outline" size="sm" aria-label={named(t.check, account.name)} onClick={() => run(async () => {
            const r = await checkAccount(project.id, account.id);
            return r.ok ? { kind: "success", text: t.checkOk } : { kind: "error", text: textFor(t.checkCodes, r.code, t.genericError) };
          })}>{t.check}</Button>{" "}
          {canReconnect && <Button variant="outline" size="sm" aria-label={named(t.reconnect, account.name)} onClick={onReconnect}>{t.reconnect}</Button>}{" "}
          <Button variant="outline" size="sm" aria-label={named(t.unlink, account.name)} onClick={() => onUnlink(account)}>{t.unlink}</Button>
          <p>
            <label>
              <input
                type="checkbox"
                aria-label={named(t.writes, account.name)}
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
            <Button type="submit" size="sm" aria-label={named(t.save, account.name)}>{t.save}</Button>
          </form>
        </div>
      )}
    </li>
  );
}

/**
 * The project's Meta connections (owner only): label, token, permissions,
 * accounts, expiry and the administration's switch. Picking accounts needs a
 * ready app and an enabled connection; revoking is always possible.
 */
export function ConnectionList({ connections, app, onPick, onRevoke }: {
  connections: AdConnection[];
  app: AppReadiness;
  onPick: (connection: AdConnection) => void;
  onRevoke: (connection: AdConnection) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = adsText(locale).accounts;
  if (connections.length === 0) return null;
  return (
    <section className="settings-section" aria-label={t.connections.title}>
      <h2>{t.connections.title}</h2>
      <ul className="settings-rows">
        {connections.map((c) => (
          <li key={c.id} className="work-settings-row">
            <div>
              <strong>{c.label}</strong>{" "}
              {c.disabled && <Badge tone="danger">{t.connections.disabled}</Badge>}
              <p className="field-hint">
                {textFor(t.connections.tokenType, c.tokenType, c.tokenType)} · {t.connections.permissions[permissionSummary(c.grantedScopes)]} · {t.connections.accounts(c.accountCount)}
              </p>
              <p className="field-hint">
                {t.tokenExpires}: {c.tokenExpiresAt ? dateText(c.tokenExpiresAt, locale, project.timezone) : t.noExpiry}
              </p>
              {soonExpiring(c.tokenExpiresAt) && <Alert kind="warning">{t.expiresSoon}</Alert>}
            </div>
            <div>
              {app === "ready" && !c.disabled && (
                <Button variant="outline" size="sm" aria-label={named(t.selectAccounts, c.label)} onClick={() => onPick(c)}>{t.selectAccounts}</Button>
              )}{" "}
              <Button variant="outline" size="sm" aria-label={named(t.connections.revoke, c.label)} onClick={() => onRevoke(c)}>{t.connections.revoke}</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Asks before a connection is revoked, naming it. */
export function RevokeConnectionDialog({ connection, onCancel, onConfirm }: { connection: AdConnection; onCancel: () => void; onConfirm: () => void }) {
  const { locale } = useWorkspace();
  const t = adsText(locale).accounts;
  return (
    <Modal title={t.connections.revokeTitle(connection.label)} description={t.connections.revokeBody} onClose={onCancel}>
      <Button variant="outline" onClick={onCancel}>{t.cancel}</Button>{" "}
      <Button variant="destructive" onClick={onConfirm}>{t.connections.revoke}</Button>
    </Modal>
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
  const [revoking, setRevoking] = useState<AdConnection | null>(null);
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
  const revoke = async (target: AdConnection) => {
    setRevoking(null);
    try {
      await revokeConnection(project.id, target.id);
      setNote({ kind: "success", text: t.connections.revoked });
    } catch (e) {
      setNote({ kind: "error", text: accountsMessage(codeOf(e), locale) });
    }
    accounts.refresh();
    connections.refresh();
    refresh();
  };
  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro}>
        {isOwner && app === "ready" && (
          <Button onClick={connect} disabled={connecting}>{connecting ? t.connecting : t.connect}</Button>
        )}
      </PageHead>
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
      {isOwner && app && app !== "ready" && <Alert kind="warning">{textFor(t.hints, app, t.genericError)}</Alert>}
      <ResourceError error={accounts.error} retry={accounts.refresh} />
      <ResourceError error={connections.error} retry={connections.refresh} />
      {accounts.data && (list.length ? (
        <ul className="settings-rows">
          {list.map((a) => (
            <Row key={a.id} account={a} owner={isOwner} canReconnect={app === "ready"} onNote={(n) => { setNote(n); accounts.refresh(); }} onUnlink={setUnlinking} onReconnect={connect} />
          ))}
        </ul>
      ) : (
        <Empty title={t.empty} />
      ))}
      {isOwner && connections.data && (
        <ConnectionList connections={connections.data.connections} app={connections.data.app} onPick={(c) => setPicking(c.id)} onRevoke={setRevoking} />
      )}
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
      {revoking && <RevokeConnectionDialog connection={revoking} onCancel={() => setRevoking(null)} onConfirm={() => revoke(revoking)} />}
    </div>
  );
}
