"use client";
import { Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { Entity } from "@/lib/api";
import type { Locale, Text } from "@/lib/i18n";
import { ResourceError, useCollection } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { useAttention } from "./attention";
import { useShell } from "./shell-context";

// The platform's card on the project home (UI restructure §5.2), always last:
// the worker, the project's connections and mailboxes, and AI cost with an
// unclear outcome. Ruling R24: it never reads /operations (all jobs,
// unbounded). The worker and the cost come from the attention items the
// shell already loaded; the connections from the collection the Connections
// page reads, which also holds the mailboxes (provider "email").

type Tone = "ok" | "warning" | "critical" | "unknown";
type Line = { key: string; tone: Tone; text: string };

const EMAIL = "email";

/** A connection's state as one of three words, like the Connections page. */
function connectorTone(row: Entity): Tone {
  const state = String(row.data.state || row.data.status || "");
  if (/failed|revoked|blocked|expired|insufficient|error/.test(state))
    return "critical";
  return /verified|connected|linked/.test(state) ? "ok" : "warning";
}

const stateWord = (tone: Tone, t: Text) =>
  tone === "ok"
    ? t("connectorConnected")
    : tone === "critical"
      ? t("connectorFailing")
      : t("connectorUnchecked");

/**
 * One line per configured provider (its first connection that is not
 * revoked, as the Connections page shows it) and, for owners, one per
 * mailbox address; a verified connection of an address wins.
 */
export function connectionLines(
  rows: readonly Entity[],
  names: Readonly<Record<string, string>>,
  t: Text,
  withMailboxes: boolean,
): Line[] {
  const live = rows.filter((row) => row.data.status !== "revoked");
  const providers = new Map<string, Entity>();
  const mailboxes = new Map<string, Entity>();
  for (const row of live) {
    const provider = String(row.data.provider ?? "");
    if (!provider) continue;
    if (provider !== EMAIL) {
      if (!providers.has(provider)) providers.set(provider, row);
      continue;
    }
    const address = String(row.data.fromAddress ?? row.data.username ?? "");
    const known = mailboxes.get(address);
    if (
      !known ||
      (connectorTone(known) !== "ok" && connectorTone(row) === "ok")
    )
      mailboxes.set(address, row);
  }
  const named = (provider: string) =>
    names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  const lines: Line[] = [...providers].map(([provider, row]) => {
    const tone = connectorTone(row);
    return {
      key: row.id,
      tone,
      text: `${named(provider)} · ${stateWord(tone, t)}`,
    };
  });
  if (withMailboxes)
    for (const [address, row] of mailboxes) {
      const tone = connectorTone(row);
      lines.push({
        key: row.id,
        tone,
        text: `${t("mailbox")}${address ? ` ${address}` : ""} · ${stateWord(tone, t)}`,
      });
    }
  return lines;
}

const amount = (micros: number, locale: Locale) =>
  new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(micros / 1_000_000);

function StatusLine({ line }: { line: Line }) {
  return (
    <li className="system-status-line" data-tone={line.tone}>
      <span className="system-status-dot" aria-hidden="true"></span>
      {line.text}
    </li>
  );
}

export function SystemStatusCard() {
  const { locale, t, isOwner } = useWorkspace();
  const shell = useShell();
  const attention = useAttention();
  const connectors = useCollection("connectors");
  // Unknown while the attention items load or failed: no state is invented.
  const items =
    attention.data && !attention.error ? attention.data.items : undefined;
  const worker: Line = !items
    ? { key: "worker", tone: "unknown", text: t("workerUnknown") }
    : items.some((item) => item.kind === "platform_worker_down")
      ? { key: "worker", tone: "critical", text: t("workerDown") }
      : { key: "worker", tone: "ok", text: t("workerRunning") };
  // Owner-only and filtered by the API; the amount is the month's unclear part.
  const unclear = items?.find((item) => item.kind === "platform_cost_unknown");
  const micros = Number(unclear?.params.micros);
  const names = Object.fromEntries(
    (shell.connectors?.providers ?? []).map((p) => [p.id, p.name]),
  );
  const lines = connectors.data
    ? connectionLines(connectors.data.items, names, t, isOwner)
    : [];
  return (
    <HomeCard
      id="home-card-system"
      title={t("systemStatus")}
      href={shell.hrefOf("operations")}
      linkLabel={t("operations")}
      className="system-status"
    >
      <ul className="system-status-lines">
        <StatusLine line={worker} />
        {lines.map((line) => (
          <StatusLine key={line.key} line={line} />
        ))}
        {unclear && Number.isFinite(micros) && (
          <StatusLine
            line={{
              key: "cost",
              tone: "warning",
              text: t("costUnknownLine").replace(
                "{amount}",
                amount(micros, locale),
              ),
            }}
          />
        )}
      </ul>
      {connectors.loading ? (
        <Skeleton />
      ) : connectors.error ? (
        <ResourceError error={connectors.error} retry={connectors.refresh} />
      ) : (
        !lines.length && <Empty title={t("noConnections")} />
      )}
    </HomeCard>
  );
}
