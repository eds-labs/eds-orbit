"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Field, FieldGroup, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
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
        <strong>{account.handle}</strong> <span>{text.platform[account.platform]}</span>{" "}
        <Badge tone={tone[account.status]}>{text.status[account.status]}</Badge>{" "}
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
  const { project, locale, isOwner, refresh } = useWorkspace();
  const t = socialText(locale).accounts;
  const params = useSearchParams();
  const accounts = useResource<SocialAccounts>(socialPath(project.id, "/accounts"));
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
  const notReady = (["x", "meta"] as const).filter((app) => apps.data && apps.data[app] !== "ready");
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
            {connectButton("x")} {connectButton("meta")}{" "}
            <Button variant="outline" onClick={() => setTelegram((open) => !open)}>
              {t.addTelegram}
            </Button>
          </>
        )}
      </PageHead>
      {banner && <Alert kind={banner.kind}>{banner.text}</Alert>}
      {notReady.map((app) => (
        <Alert key={app} kind="warning">
          {apps.data?.[app] === "invalid" ? t.appInvalid[app] : t.appNotGranted[app]}
        </Alert>
      ))}
      <Alert kind="info">{t.metaNote}</Alert>
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
        (accounts.data.items.length ? (
          <ul className="settings-rows">
            {accounts.data.items.map((account) => (
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
