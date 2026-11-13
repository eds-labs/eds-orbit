"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Field, FieldGroup, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import type { Locale } from "@/lib/i18n";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { AppHint, HiddenAppsNote, appsToHide, readHiddenApps, writeHiddenApps, type SocialApp } from "./app-hints";
import { PostizMigration } from "./legacy";
import { socialPath, type SocialAccount, type SocialAccounts, type SocialAppReadiness, type SocialMediaList } from "./api";
import { accountMessage, socialText } from "./labels";

// The project's connected social accounts (ADR 0020, S2). Everybody in the
// module sees them; owners connect (OAuth for X and Meta, a separate bot
// for Telegram), check and disconnect. Tokens never reach the browser.

const tone = { active: "success", reconnect_required: "warning", disabled: "neutral" } as const;

function codeOf(error: unknown) {
  return error instanceof ApiError ? error.code : "REQUEST_FAILED";
}

/** The display name, when it says more than the handle (e.g. a Page name). */
function otherName(account: Pick<SocialAccount, "handle" | "displayName">) {
  const plain = (value: string) => value.trim().replace(/^@/, "").toLowerCase();
  return account.displayName && plain(account.displayName) !== plain(account.handle) ? account.displayName : null;
}

/** An account's handle, name, provider and state: the editor and the read-only list share it. */
function AccountIdentity({ account, locale }: { account: SocialAccount; locale: Locale }) {
  const text = socialText(locale);
  const name = otherName(account);
  return (
    <>
      <strong>{account.handle}</strong>
      {name && <span className="social-account-name"> · {name}</span>} <span>{text.platform[account.platform]}</span>{" "}
      <Badge tone={tone[account.status]}>{text.status[account.status]}</Badge>
    </>
  );
}

/**
 * The accounts as a read-only list, for the module page once the settings
 * center manages them: the same wording as the editor, no control, and one
 * link to the section where they are connected, checked and disconnected.
 * `accounts` is null until they are read; `notice` carries a refusal.
 */
export function AccountsSummaryView({
  accounts,
  locale,
  manageHref,
  notice,
}: {
  accounts: SocialAccount[] | null;
  locale: Locale;
  manageHref: string;
  notice?: ReactNode;
}) {
  const t = socialText(locale).accounts;
  const live = accounts?.filter((account) => account.status !== "disabled") ?? [];
  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.accountsManaged} />
      {notice}
      {accounts &&
        (live.length ? (
          <ul className="settings-rows">
            {live.map((account) => (
              <li key={account.id} className="work-settings-row">
                <div>
                  <AccountIdentity account={account} locale={locale} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t.empty} />
        ))}
      <p>
        <AppLink className="text-link" href={manageHref}>
          {t.manageAccounts}
        </AppLink>
      </p>
    </div>
  );
}

/**
 * A disconnected account (WP4): kept for the history of its posts, shown
 * read-only in the archive, never with an action.
 */
function ArchivedAccountRow({ account }: { account: SocialAccount }) {
  const { locale } = useWorkspace();
  const text = socialText(locale);
  return (
    <li className="work-settings-row">
      <div>
        <AccountIdentity account={account} locale={locale} />
        {account.disabledAt && (
          <p className="field-hint">
            {text.accounts.disconnectedOn}: {new Date(account.disabledAt).toLocaleString(locale)}
          </p>
        )}
      </div>
    </li>
  );
}

export function TelegramChannelForm({ onDone }: { onDone: (message: string) => void }) {
  const { project, locale } = useWorkspace();
  const t = socialText(locale).accounts;
  const [botToken, setBotToken] = useState("");
  const [chat, setChat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(socialPath(project.id, "/accounts/telegram"), {
            method: "POST",
            body: JSON.stringify({ botToken, chat }),
          });
          setBotToken("");
          onDone(t.connected(1));
        } catch (e) {
          setError(accountMessage(codeOf(e), locale));
        } finally {
          setBusy(false);
        }
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="social-bot-token">{t.botToken}</FieldLabel>
          <Input
            id="social-bot-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            aria-describedby="social-bot-token-hint"
          />
          <p id="social-bot-token-hint" className="field-hint">
            {t.botTokenHint}
          </p>
        </Field>
        <Field>
          <FieldLabel htmlFor="social-channel">{t.chat}</FieldLabel>
          <Input id="social-channel" required value={chat} onChange={(e) => setChat(e.target.value)} />
        </Field>
      </FieldGroup>
      {error && <Alert kind="error">{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {t.save}
      </Button>
    </form>
  );
}

function AccountRow({
  account,
  owner,
  onMessage,
  onDisconnect,
}: {
  account: SocialAccount;
  owner: boolean;
  onMessage: (kind: "success" | "error", text: string) => void;
  onDisconnect: (account: SocialAccount) => void;
}) {
  const { project, locale, refresh } = useWorkspace();
  const text = socialText(locale);
  const t = text.accounts;
  const [verifying, setVerifying] = useState(false);
  const [testText, setTestText] = useState(t.verifyDefault);
  const [testImage, setTestImage] = useState("");
  // Instagram posts nothing without an image: its test post needs one.
  const needsImage = account.platform === "instagram";
  const library = useResource<SocialMediaList>(verifying && needsImage ? socialPath(project.id, "/media") : null);
  const verifyId = `social-verify-${account.id}`;
  return (
    <li className="work-settings-row">
      <div>
        <AccountIdentity account={account} locale={locale} />{" "}
        {account.capability === "write_verified" && <Badge tone="success">{t.verified}</Badge>}
        <p className="field-hint">
          {t.lastCheck}: {account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString(locale) : t.never}
          {account.lastCheckCode ? ` · ${accountMessage(account.lastCheckCode, locale)}` : ""}
        </p>
        {account.platform === "x" &&
          (owner && account.status !== "disabled" ? (
            <label className="field-hint">
              <input
                type="checkbox"
                checked={account.settings.xLongPosts}
                onChange={async (event) => {
                  try {
                    await api(socialPath(project.id, `/accounts/${account.id}`), {
                      method: "PATCH",
                      body: JSON.stringify({ version: account.version, settings: { xLongPosts: event.target.checked } }),
                    });
                    onMessage("success", t.saved);
                  } catch (e) {
                    onMessage("error", accountMessage(codeOf(e), locale));
                  }
                }}
              />{" "}
              {t.longPosts}
            </label>
          ) : (
            account.settings.xLongPosts && <p className="field-hint">{t.longPostsOn}</p>
          ))}
      </div>
      {owner && account.status !== "disabled" && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const result = await api<{ ok: boolean; code?: string }>(
                  socialPath(project.id, `/accounts/${account.id}/check`),
                  { method: "POST", body: "{}" },
                );
                onMessage(result.ok ? "success" : "error", result.ok ? t.checkOk : accountMessage(result.code ?? "", locale));
              } catch (e) {
                onMessage("error", accountMessage(codeOf(e), locale));
              }
              refresh();
            }}
          >
            {t.check}
          </Button>{" "}
          <Button variant="outline" size="sm" onClick={() => onDisconnect(account)}>
            {t.disconnect}
          </Button>
          {account.status === "active" && account.capability !== "write_verified" && (
            <>
              {" "}
              <Button variant="outline" size="sm" onClick={() => setVerifying((open) => !open)}>
                {t.verify}
              </Button>
            </>
          )}
          {verifying && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api(socialPath(project.id, `/accounts/${account.id}/verify-write`), {
                    method: "POST",
                    body: JSON.stringify({ version: account.version, text: testText, ...(testImage ? { mediaId: testImage } : {}) }),
                  });
                  setVerifying(false);
                  onMessage("success", t.verifyRequested);
                } catch (e) {
                  onMessage("error", accountMessage(codeOf(e), locale));
                }
              }}
            >
              <Field>
                <FieldLabel htmlFor={verifyId}>{t.verifyText}</FieldLabel>
                <Input id={verifyId} maxLength={280} value={testText} onChange={(e) => setTestText(e.target.value)} />
              </Field>
              {needsImage && (
                <Field>
                  <FieldLabel htmlFor={`${verifyId}-image`}>{t.verifyImage}</FieldLabel>
                  <select
                    id={`${verifyId}-image`}
                    className="input"
                    required
                    value={testImage}
                    onChange={(e) => setTestImage(e.target.value)}
                  >
                    <option value="">—</option>
                    {(library.data?.items ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <p className="field-hint">{t.verifyNote}</p>
              <Button type="submit" size="sm">
                {t.verifySend}
              </Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

export function AccountsView() {
  const { project, identity, locale, isOwner, refresh } = useWorkspace();
  const shell = useShell();
  const t = socialText(locale).accounts;
  const params = useSearchParams();
  const accounts = useResource<SocialAccounts>(socialPath(project.id, "/accounts"));
  // Disconnected accounts stay for their history (WP4): apart, collapsed.
  const live = accounts.data?.items.filter((account) => account.status !== "disabled") ?? [];
  const archived = accounts.data?.items.filter((account) => account.status === "disabled") ?? [];
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [disconnecting, setDisconnecting] = useState<SocialAccount | null>(null);
  const [connecting, setConnecting] = useState<"x" | "meta" | null>(null);
  // Coming back from the provider (browser back, a phone app handing the
  // tab back) restores this page from the cache: the buttons work again.
  useEffect(() => {
    const reset = () => setConnecting(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  // Owners learn before tapping "connect" whether a developer app is missing.
  const apps = useResource<SocialAppReadiness>(isOwner ? socialPath(project.id, "/accounts/apps") : null);
  const readiness = apps.data;
  const notReady = (["x", "meta"] as const).filter((app) => readiness && readiness[app] !== "ready");
  // Notices of platforms this project does not use; loaded after mount so
  // the server markup matches.
  const [hidden, setHidden] = useState<ReadonlySet<SocialApp>>(() => new Set());
  useEffect(() => setHidden(readHiddenApps(project.id)), [project.id]);
  const hiddenApps = appsToHide(readiness, hidden);
  const changeHidden = (next: ReadonlySet<SocialApp>) => {
    setHidden(next);
    writeHiddenApps(project.id, next);
  };
  const settingsHref = identity.workspaces.find((w) => w.id === project.workspaceId)?.canManage
    ? shell.organizationSettingsHref(project.workspaceId)
    : null;
  const connected = params.get("connected");
  const failed = params.get("error");
  const banner =
    message ??
    (connected ? { kind: "success" as const, text: t.connected(Number(connected) || 0) } : null) ??
    (failed ? { kind: "error" as const, text: accountMessage(failed, locale) } : null);

  const connect = async (app: "x" | "meta") => {
    // A message from an earlier action would read as the answer to this one.
    setMessage(null);
    setConnecting(app);
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>(
        socialPath(project.id, `/accounts/connect/${app}`),
        { method: "POST", body: "{}" },
      );
      window.location.assign(authorizeUrl);
    } catch (e) {
      setConnecting(null);
      setMessage({ kind: "error", text: accountMessage(codeOf(e), locale) });
    }
  };
  const connectButton = (app: "x" | "meta") => (
    <Button onClick={() => connect(app)} disabled={connecting !== null || notReady.includes(app)}>
      {connecting === app ? t.connecting[app] : app === "x" ? t.connectX : t.connectMeta}
    </Button>
  );

  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro}>
        {isOwner && (
          <>
            {(["x", "meta"] as const)
              .filter((app) => !hiddenApps.includes(app))
              .map((app) => (
                <Fragment key={app}>{connectButton(app)} </Fragment>
              ))}
            <Button variant="outline" onClick={() => setTelegram((open) => !open)}>
              {t.addTelegram}
            </Button>
          </>
        )}
      </PageHead>
      {banner && <Alert kind={banner.kind}>{banner.text}</Alert>}
      {readiness &&
        notReady
          .filter((app) => !hiddenApps.includes(app))
          .map((app) => (
            <AppHint
              key={app}
              app={app}
              state={readiness[app] as Exclude<SocialAppReadiness[SocialApp], "ready">}
              settingsHref={settingsHref}
              locale={locale}
              onHide={() => changeHidden(new Set([...hidden, app]))}
            />
          ))}
      {hiddenApps.length > 0 && (
        <HiddenAppsNote apps={hiddenApps} locale={locale} onShow={() => changeHidden(new Set())} />
      )}
      {isOwner && telegram && (
        <TelegramChannelForm
          onDone={(text) => {
            setTelegram(false);
            setMessage({ kind: "success", text });
            refresh();
            accounts.refresh();
          }}
        />
      )}
      <ResourceError error={accounts.error} retry={accounts.refresh} />
      {accounts.data &&
        (live.length ? (
          <ul className="settings-rows">
            {live.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                owner={isOwner}
                onMessage={(kind, text) => {
                  setMessage({ kind, text });
                  accounts.refresh();
                }}
                onDisconnect={setDisconnecting}
              />
            ))}
          </ul>
        ) : (
          <Empty title={t.empty} />
        ))}
      {archived.length > 0 && (
        <details className="social-archived-accounts">
          <summary>{t.archivedTitle(archived.length)}</summary>
          <p className="field-hint">{t.archivedHint}</p>
          <ul className="settings-rows">
            {archived.map((account) => (
              <ArchivedAccountRow key={account.id} account={account} />
            ))}
          </ul>
        </details>
      )}
      <PostizMigration />
      {disconnecting && (
        <Modal title={t.confirmTitle(disconnecting.handle)} description={t.confirmBody} onClose={() => setDisconnecting(null)}>
          <Button variant="outline" onClick={() => setDisconnecting(null)}>
            {t.cancel}
          </Button>{" "}
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(socialPath(project.id, `/accounts/${disconnecting.id}/disconnect`), {
                  method: "POST",
                  body: JSON.stringify({ version: disconnecting.version }),
                });
              } catch (e) {
                setMessage({ kind: "error", text: accountMessage(codeOf(e), locale) });
              }
              setDisconnecting(null);
              accounts.refresh();
            }}
          >
            {t.disconnect}
          </Button>
        </Modal>
      )}
    </div>
  );
}
