"use client";
// Executions (work orders) of the agent platform (ADR 0021, WP1.8): the
// list with a status filter and cost, and the detail with origin, the
// people it acts for, the step log, linked approvals, the result and
// readable error texts. Retry and cancel for owners and editors.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { post, useResource, usd, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Button, Empty, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { agentPaths, errorCode, requestId, useAgentAction } from "./api";
import { agentHref, executionHref, OPEN_WORK } from "./logic";
import { AgentError, WorkStatusBadge } from "./parts";
import {
  agentErrorText,
  originText,
  riskText,
  WORK_ORDER_STATUSES,
  workStatusText,
} from "./text";
import type { WorkOrderPage, WorkOrderView } from "./types";

/** "$0.12 of $0.50", or the unclear note. */
export function costText(
  item: Pick<WorkOrderView, "spentMicros" | "ceilingMicros" | "costUnknown">,
  locale: Locale,
) {
  const de = locale === "de";
  const spent = `${usd(item.spentMicros)} ${de ? "von" : "of"} ${usd(item.ceilingMicros)}`;
  return item.costUnknown
    ? `${spent} (${de ? "Kosten unklar" : "cost unclear"})`
    : spent;
}

/** Who a person is on the page: "you" for the member, else a short id (no names in the API). */
export function personText(
  userId: string | null | undefined,
  me: string,
  locale: Locale,
) {
  if (!userId) return "—";
  if (userId === me) return locale === "de" ? "Du" : "You";
  return `${locale === "de" ? "Mitglied" : "Member"} ${userId.slice(0, 8)}`;
}

export function ExecutionList({
  agentId,
  agentNames,
}: {
  agentId?: string;
  agentNames?: ReadonlyMap<string, string>;
}) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [older, setOlder] = useState<WorkOrderView[]>([]);
  const page = useResource<WorkOrderPage>(
    agentPaths.workOrders(project.id, { agentId, status, cursor, limit: 25 }),
  );
  const items = [...older, ...(page.data?.items ?? [])];
  return (
    <section className="panel" aria-labelledby="agent-executions-title">
      <div className="panel-head">
        <div>
          <h2 id="agent-executions-title">
            {de ? "Ausführungen" : "Executions"}
          </h2>
          <p>{de ? "Neueste zuerst." : "Newest first."}</p>
        </div>
        <label className="agents-filter">
          <span>{de ? "Status" : "Status"}</span>
          <select
            className="input"
            value={status}
            onChange={(e) => {
              // A new filter starts the list again.
              setStatus(e.target.value);
              setCursor(undefined);
              setOlder([]);
            }}
          >
            <option value="">{de ? "Alle" : "All"}</option>
            {WORK_ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {workStatusText(s, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {page.error && (
        <AgentError code={errorCode(page.error)} locale={locale} />
      )}
      {page.loading && !items.length && <Loading />}
      {!page.loading && !page.error && !items.length && (
        <Empty title={de ? "Noch keine Ausführungen." : "No executions yet."} />
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{de ? "Gestartet" : "Started"}</th>
                {!agentId && <th scope="col">{de ? "Agent" : "Agent"}</th>}
                <th scope="col">{de ? "Status" : "Status"}</th>
                <th scope="col">{de ? "Herkunft" : "Origin"}</th>
                <th scope="col">{de ? "Kosten" : "Cost"}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.agentId ? (
                      <AppLink
                        href={executionHref(base, item.agentId, item.id)}
                      >
                        {when(item.createdAt, locale, project.timezone)}
                      </AppLink>
                    ) : (
                      when(item.createdAt, locale, project.timezone)
                    )}
                  </td>
                  {!agentId && (
                    <td>
                      {(item.agentId && agentNames?.get(item.agentId)) ||
                        item.agentId?.slice(0, 8) ||
                        "—"}
                    </td>
                  )}
                  <td>
                    <WorkStatusBadge status={item.status} locale={locale} />
                    {item.errorCode && (
                      <small>{agentErrorText(item.errorCode, locale)}</small>
                    )}
                  </td>
                  <td>{originText(item.origin, locale)}</td>
                  <td>{costText(item, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.data?.nextCursor && (
        <div className="agents-actions agents-inset">
          <Button
            variant="outline"
            size="sm"
            disabled={page.loading}
            onClick={() => {
              setOlder(items);
              setCursor(page.data!.nextCursor!);
            }}
          >
            {de ? "Ältere laden" : "Load older"}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ExecutionDetail({
  agentId,
  workOrderId,
}: {
  agentId: string;
  workOrderId: string;
}) {
  const { project, locale, canEdit } = useWorkspace();
  const resource = useResource<WorkOrderView>(
    agentPaths.workOrder(project.id, workOrderId),
  );
  if (resource.loading && !resource.data) return <Loading />;
  if (resource.error || !resource.data)
    return <AgentError code={errorCode(resource.error)} locale={locale} />;
  return (
    <ExecutionView
      item={resource.data}
      agentId={agentId}
      canRun={canEdit}
      onChanged={resource.refresh}
    />
  );
}

/** One execution, rendered from the API's view (exported for tests). */
export function ExecutionView({
  item,
  agentId,
  canRun,
  onChanged,
}: {
  item: WorkOrderView;
  agentId: string;
  canRun: boolean;
  onChanged(): void;
}) {
  const { project, locale, identity } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const cancel = useAgentAction();
  const retry = useAgentAction();
  const open = OPEN_WORK.has(item.status);
  const steps = item.steps ?? [];
  const requests = item.result?.actionRequestIds ?? [];
  const me = identity.user.id;
  return (
    <div className="agents-stack">
      <p>
        <AppLink
          className="back-link"
          href={agentHref(base, agentId, "executions")}
        >
          ←{" "}
          {de ? "Alle Ausführungen des Agenten" : "All executions of the agent"}
        </AppLink>
      </p>
      <section className="panel" aria-labelledby="execution-title">
        <div className="panel-head">
          <div>
            <h2 id="execution-title">
              {de ? "Ausführung" : "Execution"}{" "}
              {when(item.createdAt, locale, project.timezone)}
            </h2>
            <p>
              <WorkStatusBadge status={item.status} locale={locale} /> ·{" "}
              {originText(item.origin, locale)}
              {item.agentVersion !== null &&
                ` · ${de ? "Version" : "version"} ${item.agentVersion}`}
            </p>
          </div>
          {canRun && (
            <div className="page-actions agents-wrap">
              {open && (
                <Button
                  variant="outline"
                  disabled={cancel.pending}
                  onClick={async () => {
                    const done = await cancel.run(() =>
                      post(
                        `${agentPaths.workOrder(project.id, item.id)}/cancel`,
                        {},
                      ),
                    );
                    if (done) onChanged();
                  }}
                >
                  {de ? "Abbrechen" : "Cancel"}
                </Button>
              )}
              {!open && (
                <Button
                  disabled={retry.pending}
                  onClick={async () => {
                    const next = await retry.run(() =>
                      post<WorkOrderView>(
                        `${agentPaths.workOrder(project.id, item.id)}/retry`,
                        {
                          requestId: requestId(),
                        },
                      ),
                    );
                    if (next)
                      router.push(executionHref(base, agentId, next.id));
                  }}
                >
                  {de ? "Erneut ausführen" : "Retry"}
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="agents-section-body">
          <AgentError code={cancel.code ?? retry.code} locale={locale} />
          {item.errorCode && (
            <Alert kind={item.status === "canceled" ? "info" : "error"}>
              <p>{agentErrorText(item.errorCode, locale)}</p>
              <p className="agents-code">
                <code>{item.errorCode}</code>
              </p>
            </Alert>
          )}
          <dl className="agents-facts">
            <div>
              <dt>
                {de ? "Im Auftrag von (Sponsor)" : "On behalf of (sponsor)"}
              </dt>
              <dd>{personText(item.onBehalfOf.sponsorUserId, me, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Angestoßen von" : "Requested by"}</dt>
              <dd>{personText(item.onBehalfOf.requesterUserId, me, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Kosten" : "Cost"}</dt>
              <dd>{costText(item, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Gestartet / beendet" : "Started / finished"}</dt>
              <dd>
                {when(item.startedAt, locale, project.timezone)} /{" "}
                {when(item.finishedAt, locale, project.timezone)}
              </dd>
            </div>
            {item.subject && (
              <div>
                <dt>{de ? "Gegenstand" : "Subject"}</dt>
                <dd>
                  {item.subject.type} {item.subject.id ?? ""}
                </dd>
              </div>
            )}
            {item.originRef && (
              <div>
                <dt>{de ? "Bezug" : "Refers to"}</dt>
                <dd>
                  {item.origin === "manual" ? (
                    <AppLink
                      href={executionHref(base, agentId, item.originRef)}
                    >
                      {de ? "Vorherige Ausführung" : "Previous execution"}
                    </AppLink>
                  ) : (
                    item.originRef
                  )}
                </dd>
              </div>
            )}
            {item.depth > 0 && (
              <div>
                <dt>{de ? "Delegationstiefe" : "Delegation depth"}</dt>
                <dd>{item.depth}</dd>
              </div>
            )}
          </dl>
          {item.goal && (
            <>
              <h3 className="agents-subhead">{de ? "Ziel" : "Goal"}</h3>
              <p className="agents-prose">{item.goal}</p>
            </>
          )}
          <h3 className="agents-subhead">{de ? "Ergebnis" : "Result"}</h3>
          {item.result?.summary ? (
            <>
              {item.result.outcome && (
                <p className="agents-note">{item.result.outcome}</p>
              )}
              <p className="agents-prose">{item.result.summary}</p>
            </>
          ) : (
            <p className="agents-note">
              {de ? "Kein Ergebnis." : "No result."}
            </p>
          )}
          <h3 className="agents-subhead">{de ? "Freigaben" : "Approvals"}</h3>
          {requests.length ? (
            <ul className="agents-list">
              {requests.map((id) => (
                <li key={id}>
                  <AppLink href={shell.hrefOf("decisions")}>
                    {de ? "Freigabe" : "Approval"} <code>{id.slice(0, 8)}</code>
                  </AppLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="agents-note">
              {de
                ? "Diese Ausführung hat keine Freigaben angefragt."
                : "This execution requested no approvals."}
            </p>
          )}
        </div>
      </section>
      <section className="panel" aria-labelledby="execution-steps-title">
        <div className="panel-head">
          <div>
            <h2 id="execution-steps-title">{de ? "Schritte" : "Steps"}</h2>
            <p>
              {de
                ? "Tool-Aufrufe mit Risiko und Ergebnis."
                : "Tool calls with risk and outcome."}
            </p>
          </div>
        </div>
        {steps.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Tool</th>
                  <th scope="col">{de ? "Risiko" : "Risk"}</th>
                  <th scope="col">{de ? "Ergebnis" : "Outcome"}</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => (
                  <tr key={step.index}>
                    <td>{step.index + 1}</td>
                    <td>
                      <code>{step.tool}</code>
                    </td>
                    <td>{riskText(step.risk, locale)}</td>
                    <td>
                      {step.outcome === "succeeded"
                        ? de
                          ? "Erfolgreich"
                          : "Succeeded"
                        : de
                          ? "Fehlgeschlagen"
                          : "Failed"}
                    </td>
                    <td>
                      {step.code ? (
                        <code title={agentErrorText(step.code, locale)}>
                          {step.code}
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="agents-note agents-inset">
            {de ? "Keine Schritte aufgezeichnet." : "No steps recorded."}
          </p>
        )}
      </section>
    </div>
  );
}
