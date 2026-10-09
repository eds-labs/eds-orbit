"use client";
import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import {
  collectionPath,
  post,
  useMutation,
  useResource,
  when,
} from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

/** `GET /telegram`: never a token, only the connection state. */
export type TelegramStatus = {
  status: "none" | "pending" | "linked" | "disabled";
  linkedAt: string | null;
};
type LinkCode = { linkCode: string; expiresAt: string };

const statusLabels: Record<TelegramStatus["status"], [string, string]> = {
  none: ["Not connected", "Nicht verbunden"],
  pending: ["Waiting for /start", "Wartet auf /start"],
  linked: ["Connected", "Verbunden"],
  disabled: ["Disconnected", "Getrennt"],
};

/**
 * The owner's Telegram bot (spec §10): the @BotFather token goes in once and
 * is never shown or kept in page state (an uncontrolled field, cleared on
 * submit); the one-time link code binds the owner's private chat.
 */
export function TelegramPanel({
  status,
  link,
  de,
  timezone,
  pending,
  error,
  onConnect,
  onDisconnect,
}: {
  status: TelegramStatus;
  link: LinkCode | null;
  de: boolean;
  timezone: string;
  pending: boolean;
  error: string;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const locale = de ? "de" : "en";
  const connected = status.status === "pending" || status.status === "linked";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = String(new FormData(form).get("token") ?? "").trim();
    form.reset();
    if (token) onConnect(token);
  }
  return (
    <section className="connector telegram-connection">
      <div className="connector-mark">
        <Send />
      </div>
      <div className="connector-body">
        <h2>Telegram</h2>
        <p>
          {de
            ? "Dein privater Orbit-Bot: Vorschau jedes Auftrags-Posts mit Stop, Hinweise, Tagesbericht und /pause."
            : "Your private Orbit bot: a preview of every assignment post with Stop, notices, a daily report and /pause."}
        </p>
        <div className="detail-summary">
          <Badge
            tone={
              status.status === "linked"
                ? "success"
                : status.status === "pending"
                  ? "warning"
                  : "neutral"
            }
          >
            {(statusLabels[status.status] ?? statusLabels.none)[de ? 1 : 0]}
          </Badge>
          {status.status === "linked" && status.linkedAt && (
            <span>
              {de ? "Verbunden seit" : "Connected since"}{" "}
              {when(status.linkedAt, locale, timezone)}
            </span>
          )}
        </div>
        {link && status.status !== "linked" && (
          <Alert>
            {de ? "Sende deinem Bot in Telegram" : "Send your bot in Telegram"}{" "}
            <code>/start {link.linkCode}</code>{" "}
            {de ? "– gültig bis" : "– valid until"}{" "}
            <time dateTime={link.expiresAt}>
              {when(link.expiresAt, locale, timezone)}
            </time>
            .{" "}
            {de
              ? "Der Code gilt einmal und nur für deinen privaten Chat."
              : "The code works once and only in your private chat."}
          </Alert>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <form className="telegram-token" onSubmit={submit}>
          <label htmlFor="telegram-token">
            {connected
              ? de
                ? "Neuen Bot-Token eingeben (ersetzt den bisherigen Bot)"
                : "Enter a new bot token (replaces the current bot)"
              : de
                ? "Bot-Token von @BotFather"
                : "Bot token from @BotFather"}
          </label>
          <input
            id="telegram-token"
            className="input"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={200}
          />
          <small>
            {de
              ? "Der Token wird verschlüsselt gespeichert und nie wieder angezeigt."
              : "The token is stored encrypted and never shown again."}
          </small>
          <div className="form-actions">
            <Button type="submit" disabled={pending}>
              {de ? "Verbinden" : "Connect"}
            </Button>
            {connected && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onDisconnect}
              >
                {de ? "Trennen" : "Disconnect"}
              </Button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

/** Settings → Connections → Telegram, for owners only; hidden while Orbit Agents is off. */
export function TelegramConnection() {
  const { locale, project, isOwner } = useWorkspace();
  const de = locale === "de";
  const [revision, setRevision] = useState(0);
  const status = useResource<TelegramStatus>(
    isOwner
      ? collectionPath(project.id, `telegram?revision=${revision}`)
      : null,
  );
  const [link, setLink] = useState<LinkCode | null>(null);
  const mutation = useMutation(() => setRevision((n) => n + 1));
  // 404: Orbit Agents is off; 403: not the owner (any longer).
  if (!isOwner || status.error?.status === 404 || status.error?.status === 403)
    return null;
  if (!status.data)
    return status.error ? (
      <Alert kind="error">Telegram: {status.error.message}</Alert>
    ) : null;
  return (
    <TelegramPanel
      status={status.data}
      link={link}
      de={de}
      timezone={project.timezone}
      pending={mutation.pending}
      error={mutation.error ?? ""}
      onConnect={(token) =>
        mutation.run(async () => {
          setLink(
            await post<LinkCode>(
              collectionPath(project.id, "telegram/connect"),
              { token },
            ),
          );
        })
      }
      onDisconnect={() =>
        mutation.run(async () => {
          await post(collectionPath(project.id, "telegram/disconnect"), {});
          setLink(null);
        })
      }
    />
  );
}
