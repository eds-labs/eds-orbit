"use client";
import { useState } from "react";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { socialText } from "./labels";
import type { SocialPlatform } from "./api";

// Moving a project from Postiz to Social (ADR 0020, S10), on Social →
// Accounts: map Marketing's Postiz channels to accounts, see what Postiz
// still holds, copy its history read-only, and switch Marketing's
// publishing backend (Postiz → draining → Social, and back). The data comes
// from Marketing's /marketing/social-migration routes; without the
// Marketing module the section stays empty.

type Backend = "postiz" | "postiz_draining" | "social";
export type MigrationView = {
  backend: Backend;
  channels: Array<{
    integrationId: string;
    name: string;
    platform: SocialPlatform | null;
    accountId: string | null;
    suggestedAccountId: string | null;
  }>;
  accounts: Array<{
    accountId: string;
    platform: SocialPlatform;
    handle: string;
    displayName: string;
    status: string;
    legacyPostizIntegrationId: string | null;
  }>;
  inventory: {
    backend: Backend;
    channels: { assigned: number; mapped: number };
    publications: Record<string, number>;
    postizDrafts: Record<string, number>;
    openExceptions: Record<string, number>;
    blockingSwitch: number;
    readyToSwitch: boolean;
  };
};
export type MirrorResult = {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  unmapped: number;
  byStatus: Record<string, number>;
};

const TEXT = {
  en: {
    title: "Move from Postiz",
    intro: "Map each Postiz channel to its Social account, copy the Postiz history, then let Postiz finish and switch Marketing to Social.",
    backend: { postiz: "Marketing publishes through Postiz.", postiz_draining: "Postiz finishes what it has; nothing new goes to it.", social: "Marketing publishes through Social." } as Record<Backend, string>,
    channel: "Postiz channel",
    account: "Social account",
    none: "Not mapped",
    unsupported: "not available in Social yet",
    suggested: (name: string) => `Suggested: ${name}`,
    pending: (n: number) => `Postiz still has ${n} posts or drafts to settle.`,
    clear: "Postiz has nothing left to settle.",
    unmapped: "Map every channel before switching.",
    notInSocial: (names: string) => `Before switching, remove from Marketing's channels what Social cannot post to yet: ${names}.`,
    drain: "Stop new posts to Postiz",
    toSocial: "Switch to Social",
    toPostiz: "Back to Postiz",
    check: "Check history",
    copy: "Copy history",
    mirror: (r: MirrorResult) => `${r.created} to copy, ${r.updated} to update, ${r.unmapped} on unmapped channels`,
    copied: (r: MirrorResult) => `${r.created} copied, ${r.updated} updated, ${r.unmapped} on unmapped channels`,
  },
  de: {
    title: "Umzug von Postiz",
    intro: "Ordne jeden Postiz-Kanal seinem Social-Konto zu, übernimm den Postiz-Verlauf, lass Postiz auslaufen und stelle Marketing auf Social um.",
    backend: { postiz: "Marketing veröffentlicht über Postiz.", postiz_draining: "Postiz erledigt, was es hat; Neues geht nicht mehr an Postiz.", social: "Marketing veröffentlicht über Social." } as Record<Backend, string>,
    channel: "Postiz-Kanal",
    account: "Social-Konto",
    none: "Nicht zugeordnet",
    unsupported: "in Social noch nicht verfügbar",
    suggested: (name: string) => `Vorschlag: ${name}`,
    pending: (n: number) => `Postiz hat noch ${n} Beiträge oder Entwürfe offen.`,
    clear: "Bei Postiz ist nichts mehr offen.",
    unmapped: "Ordne vor dem Umstellen jeden Kanal zu.",
    notInSocial: (names: string) => `Entferne vor dem Umstellen aus den Marketing-Kanälen, was Social noch nicht bedienen kann: ${names}.`,
    drain: "Keine neuen Beiträge an Postiz",
    toSocial: "Auf Social umstellen",
    toPostiz: "Zurück zu Postiz",
    check: "Verlauf prüfen",
    copy: "Verlauf übernehmen",
    mirror: (r: MirrorResult) => `${r.created} zu übernehmen, ${r.updated} zu aktualisieren, ${r.unmapped} auf nicht zugeordneten Kanälen`,
    copied: (r: MirrorResult) => `${r.created} übernommen, ${r.updated} aktualisiert, ${r.unmapped} auf nicht zugeordneten Kanälen`,
  },
};

export function MigrationPanel({
  view,
  owner,
  locale,
  busy,
  mirror,
  onMap,
  onBackend,
  onMirror,
}: {
  view: MigrationView;
  owner: boolean;
  locale: "en" | "de";
  busy: boolean;
  mirror: MirrorResult | null;
  onMap: (integrationId: string, accountId: string | null) => void;
  onBackend: (backend: Backend) => void;
  onMirror: (dryRun: boolean) => void;
}) {
  const t = TEXT[locale];
  const platforms = socialText(locale).platform;
  const unsupported = view.channels.filter((c) => !c.platform);
  const allMapped = view.channels.every((c) => c.platform && c.accountId);
  const label = (a: MigrationView["accounts"][number]) =>
    a.displayName && a.displayName !== a.handle ? `${a.displayName} (${a.handle})` : a.handle;
  const name = (accountId: string | null) => {
    const a = view.accounts.find((x) => x.accountId === accountId);
    return a ? label(a) : t.none;
  };
  return (
    <section className="settings-section" aria-label={t.title}>
      <h2>{t.title}</h2>
      <p className="field-hint">{t.intro}</p>
      <p>
        <strong>{t.backend[view.backend]}</strong>
      </p>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.channel}</th>
            <th scope="col">{t.account}</th>
          </tr>
        </thead>
        <tbody>
          {view.channels.map((c) => (
            <tr key={c.integrationId}>
              <td>
                {c.name} {c.platform && <span className="field-hint">{platforms[c.platform]}</span>}
              </td>
              <td>
                {!c.platform ? (
                  <span className="field-hint">{t.unsupported}</span>
                ) : owner ? (
                  <select
                    aria-label={`${t.account}: ${c.name}`}
                    value={c.accountId ?? ""}
                    disabled={busy}
                    onChange={(e) => onMap(c.integrationId, e.target.value || null)}
                  >
                    <option value="">{t.none}</option>
                    {view.accounts
                      .filter((a) => a.platform === c.platform)
                      .map((a) => (
                        <option key={a.accountId} value={a.accountId}>
                          {label(a)}
                        </option>
                      ))}
                  </select>
                ) : (
                  name(c.accountId)
                )}
                {!c.accountId && c.suggestedAccountId && <span className="field-hint"> {t.suggested(name(c.suggestedAccountId))}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-hint">{view.inventory.blockingSwitch ? t.pending(view.inventory.blockingSwitch) : t.clear}</p>
      {unsupported.length > 0 && <p className="field-hint">{t.notInSocial(unsupported.map((c) => c.name).join(", "))}</p>}
      {!allMapped && !unsupported.length && <p className="field-hint">{t.unmapped}</p>}
      {mirror && <Alert kind="info">{mirror.dryRun ? t.mirror(mirror) : t.copied(mirror)}</Alert>}
      {owner && (
        <div className="button-row">
          <Button variant="outline" disabled={busy} onClick={() => onMirror(true)}>
            {t.check}
          </Button>
          {mirror?.dryRun && (
            <Button disabled={busy} onClick={() => onMirror(false)}>
              {t.copy}
            </Button>
          )}
          {view.backend === "postiz" && (
            <Button variant="outline" disabled={busy} onClick={() => onBackend("postiz_draining")}>
              {t.drain}
            </Button>
          )}
          {view.backend !== "social" && (
            <Button disabled={busy || !allMapped || !view.inventory.readyToSwitch} onClick={() => onBackend("social")}>
              {t.toSocial}
            </Button>
          )}
          {view.backend !== "postiz" && (
            <Button variant="outline" disabled={busy} onClick={() => onBackend("postiz")}>
              {t.toPostiz}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** The section on Social → Accounts; empty without Marketing or Postiz channels. */
export function PostizMigration() {
  const { project, locale, isOwner } = useWorkspace();
  const base = `/projects/${encodeURIComponent(project.id)}/marketing`;
  const view = useResource<MigrationView>(`${base}/social-migration`);
  const [busy, setBusy] = useState(false);
  const [mirror, setMirror] = useState<MirrorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!view.data || !view.data.channels.length) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : String(e));
    } finally {
      setBusy(false);
      view.refresh();
    }
  };
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <MigrationPanel
        view={view.data}
        owner={isOwner}
        locale={locale}
        busy={busy}
        mirror={mirror}
        onMap={(integrationId, accountId) =>
          act(() => api(`${base}/social-migration/mapping`, { method: "PUT", body: JSON.stringify({ integrationId, accountId }) }))
        }
        onMirror={(dryRun) =>
          act(async () =>
            setMirror(await api<MirrorResult>(`${base}/social-migration/mirror`, { method: "POST", body: JSON.stringify({ dryRun }) })),
          )
        }
        onBackend={(backend) =>
          act(async () => {
            const current = await api<{ version: number }>(`${base}/settings`);
            await api(`${base}/settings`, {
              method: "PUT",
              body: JSON.stringify({ settings: { publishingBackend: backend }, version: current.version }),
            });
          })
        }
      />
    </>
  );
}
