"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { collectionPath, useResource, type Entity } from "@/lib/api";
import { Alert, Badge, Button, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { supportPath, type CustomerAccount } from "./api";
import type { SupportText } from "./labels";

// Live customer account of a ticket (ADR 0011). Read on demand only: each
// check is a call to the customer's product and is audited; nothing is kept.

const date = (value: string | null, locale: string, unknown: string) =>
  value ? new Date(value).toLocaleDateString(locale) : unknown;
const amount = (value: number | null, unknown: string) =>
  value === null ? unknown : value.toLocaleString();

export function CustomerAccountCard({
  ticketId,
  t,
}: {
  ticketId: string;
  t: SupportText;
}) {
  const { project, locale } = useWorkspace();
  const [requested, setRequested] = useState(false);
  const account = useResource<CustomerAccount>(
    requested
      ? supportPath(project.id, `/tickets/${ticketId}/customer-context`)
      : null,
  );
  const a = t.account;
  return (
    <section className="support-account" aria-label={a.title}>
      <h3>{a.title}</h3>
      <p>
        <small>{a.hint}</small>
      </p>
      {!requested ? (
        <Button size="sm" variant="outline" onClick={() => setRequested(true)}>
          {a.load}
        </Button>
      ) : account.loading ? (
        <Loading />
      ) : account.error || !account.data ? (
        <Alert kind="error">{a.state.unavailable}</Alert>
      ) : (
        <>
          <AccountBody data={account.data} t={t} locale={locale} />
          <Button size="sm" variant="ghost" onClick={account.refresh}>
            <RefreshCw data-icon="inline-start" />
            {a.refresh}
          </Button>
        </>
      )}
    </section>
  );
}

function AccountBody({
  data,
  t,
  locale,
}: {
  data: CustomerAccount;
  t: SupportText;
  locale: string;
}) {
  const a = t.account;
  const { result } = data;
  if (result.status !== "ok")
    return (
      <Alert kind={result.status === "unavailable" ? "error" : "info"}>
        {a.state[result.status]}
      </Alert>
    );
  const c = result.context;
  const missing = (section: "subscription" | "entitlements" | "usage") =>
    c.freshness.availability[section] === "not_applicable"
      ? a.notApplicable
      : a.notAvailable;
  return (
    <dl>
      <dt>{a.source}</dt>
      <dd>
        {c.source.system} · {a.asOf}{" "}
        {new Date(data.checkedAt).toLocaleTimeString(locale)}
      </dd>
      <dt>{a.subscription}</dt>
      <dd>
        {c.subscription ? (
          <>
            <Badge>{c.subscription.status}</Badge>{" "}
            {c.subscription.plan?.name ?? a.none}
            <br />
            {a.periodEnd}:{" "}
            {date(c.subscription.currentPeriodEnd, locale, a.unknown)}
            {c.subscription.trialEndsAt && (
              <>
                <br />
                {a.trialEnds}:{" "}
                {date(c.subscription.trialEndsAt, locale, a.unknown)}
              </>
            )}
            {c.subscription.cancellation.state !== "none" && (
              <>
                <br />
                {a.cancellation}: {c.subscription.cancellation.state} (
                {date(
                  c.subscription.cancellation.effectiveAt,
                  locale,
                  a.unknown,
                )}
                )
              </>
            )}
          </>
        ) : (
          missing("subscription")
        )}
      </dd>
      <dt>{a.features}</dt>
      <dd>
        {c.entitlements ? (
          <ul>
            {c.entitlements.map((e) => (
              <li key={e.key}>
                <Badge
                  tone={
                    e.state === "granted"
                      ? "success"
                      : e.state === "denied"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {e.state}
                </Badge>{" "}
                {e.label}
                {e.reason ? ` (${e.reason})` : ""}
              </li>
            ))}
          </ul>
        ) : (
          missing("entitlements")
        )}
      </dd>
      <dt>{a.usage}</dt>
      <dd>
        {c.usage ? (
          <ul>
            {c.usage.map((u) => (
              <li key={u.key}>
                {u.label}:{" "}
                {u.unlimited === true
                  ? a.unlimited
                  : `${amount(u.remaining, a.unknown)} / ${amount(u.limit, a.unknown)} ${u.unit}`}
                {u.resetsAt
                  ? ` · ${a.resets} ${date(u.resetsAt, locale, a.unknown)}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : (
          missing("usage")
        )}
      </dd>
    </dl>
  );
}

/** The inbox form's choice of a customer context integration (owner). */
export function CustomerContextBinding({
  value,
  disabled,
  onChange,
  t,
}: {
  value: string;
  disabled: boolean;
  onChange: (connectionId: string) => void;
  t: SupportText;
}) {
  const { project } = useWorkspace();
  const connectors = useResource<{ items: Entity[] }>(
    collectionPath(project.id, "connectors"),
  );
  const items = (connectors.data?.items ?? []).filter(
    (row) => row.data.provider === "customer_context",
  );
  const a = t.account;
  return (
    <label>
      <span>{a.binding}</span>
      <select
        className="input"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{a.bindingNone}</option>
        {items.map((row) => (
          <option key={row.id} value={row.id}>
            {String(row.data.label ?? row.data.sourceSystem)} (
            {String(row.data.sourceSystem)}
            {["read_verified", "write_verified"].includes(
              String(row.data.status),
            )
              ? ""
              : `, ${a.bindingUnverified}`}
            )
          </option>
        ))}
      </select>
      <small>{a.bindingHint}</small>
    </label>
  );
}
