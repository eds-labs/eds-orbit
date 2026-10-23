"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { collectionPath, useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Skeleton,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { SettingsSection } from "@/platform/shell/types";
import { ResourceError } from "@/platform/ui/collection";
import {
  financeApi,
  financePath,
  type Account,
  type Category,
  type CostCenter,
  type FinanceSettings,
  type FxRate,
  type MailboxBinding,
  type SettingsResponse,
} from "./api";
import { useFinanceAccess } from "./access";
import { financeText, type FinanceText } from "./labels";
import { CURRENCIES, microsToUnits, unitsToMicros } from "./money";

// Finance's sections of the project settings (spec §9): mailboxes, accounts
// and categories, cost centers, currencies and exchange rates, AI extraction.
// Owner-only controls (finance.settings) are disabled for other members as the
// advertised module access says; the API stays the authority.

/** The server maximum of the daily AI ceiling: 1000 USD. */
export const MAX_CEILING_MICROS = 1_000_000_000;
const DEFAULT_FOLDER = "Orbit/Processed";

// ---------------------------------------------------------------- mailboxes

/** One mailbox of GET /api/projects/:id/email (no credentials). */
export type EmailMailbox = {
  connection: { id: string; data: Record<string, any> };
  default: boolean;
  inUse: number;
  inbound: { checkedAt: string | null; lastError: string | null } | null;
  lastArchiveError?: string | null;
};
export type MailboxRowData = {
  mailbox: EmailMailbox;
  binding: MailboxBinding | null;
  /** Another module that owns the mailbox, if any. */
  owner: string | null;
  error: string | null;
};

/**
 * The e-mail connections finance can show: only mailboxes (a connection of
 * another provider is skipped), each with its finance binding and the module
 * that owns it when that is not finance.
 */
export function bindableMailboxes(
  mailboxes: readonly EmailMailbox[],
  bindings: readonly MailboxBinding[],
): MailboxRowData[] {
  return mailboxes
    .filter((m) => {
      const provider = m.connection.data.provider;
      return provider === undefined || provider === "email";
    })
    .map((mailbox) => {
      const binding =
        bindings.find(
          (b) => b.emailConnectionId === mailbox.connection.id && b.active,
        ) ?? null;
      const ownerModule = mailbox.connection.data.ownerModule;
      return {
        mailbox,
        binding,
        owner:
          typeof ownerModule === "string" && ownerModule !== "finance"
            ? ownerModule
            : null,
        error: binding?.lastArchiveError ?? mailbox.lastArchiveError ?? null,
      };
    });
}

function MailboxRow({
  t,
  row,
  canManage,
  pending,
  onBind,
  onUnbind,
}: {
  t: FinanceText;
  row: MailboxRowData;
  canManage: boolean;
  pending: boolean;
  onBind: (connectionId: string, archiveFolder: string) => void;
  onUnbind: (bindingId: string) => void;
}) {
  const id = row.mailbox.connection.id;
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const { binding } = row;
  return (
    <li className="settings-row">
      <strong>{String(row.mailbox.connection.data.fromAddress ?? id)}</strong>{" "}
      {binding && <Badge tone="success">{t.mailboxes.bound}</Badge>}
      {row.owner && (
        <Badge>
          {t.mailboxes.ownedBy} {row.owner}
        </Badge>
      )}
      {binding && (
        <p className="panel-note">
          {t.mailboxes.archiveFolder}: {binding.archiveFolder}
        </p>
      )}
      {binding && row.error && (
        <Alert kind="warning">
          <strong>{t.mailboxes.archiveError}</strong>{" "}
          {t.mailboxes.archiveErrors[row.error] ??
            t.mailboxes.archiveErrorUnknown}
        </Alert>
      )}
      {canManage && binding && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onUnbind(binding.id)}
        >
          {t.mailboxes.unbind}
        </Button>
      )}
      {canManage && !binding && !row.owner && (
        <span className="settings-row-actions">
          <label>
            <span>{t.mailboxes.archiveFolder}</span>
            <Input
              value={folder}
              maxLength={200}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={pending || !folder.trim()}
            onClick={() => onBind(id, folder.trim())}
          >
            {t.mailboxes.bind}
          </Button>
        </span>
      )}
    </li>
  );
}

export function MailboxList({
  t,
  rows,
  canManage,
  pending,
  onBind,
  onUnbind,
}: {
  t: FinanceText;
  rows: MailboxRowData[];
  canManage: boolean;
  pending: boolean;
  onBind: (connectionId: string, archiveFolder: string) => void;
  onUnbind: (bindingId: string) => void;
}) {
  if (!rows.length) return <p className="panel-note">{t.mailboxes.none}</p>;
  return (
    <ul className="settings-rows">
      {rows.map((row) => (
        <MailboxRow
          key={row.mailbox.connection.id}
          t={t}
          row={row}
          canManage={canManage}
          pending={pending}
          onBind={onBind}
          onUnbind={onUnbind}
        />
      ))}
    </ul>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {hint && <p>{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

type Loadable = {
  loading: boolean;
  error: Error | null;
  refresh: () => void;
};

/** A section's read states: skeleton while loading, the error with retry on failure. */
export function LoadState({
  resources,
  children,
}: {
  resources: readonly Loadable[];
  children: ReactNode;
}) {
  const failed = resources.find((r) => r.error);
  if (failed)
    return <ResourceError error={failed.error} retry={failed.refresh} />;
  if (resources.some((r) => r.loading)) return <Skeleton />;
  return <>{children}</>;
}

function Mailboxes({ t }: { t: FinanceText }) {
  const { project } = useWorkspace();
  const { owner } = useFinanceAccess();
  // Both reads are owner-only in the API.
  const email = useResource<{ mailboxes?: EmailMailbox[] }>(
    owner ? collectionPath(project.id, "email") : null,
  );
  const bindings = useResource<{ items: MailboxBinding[] }>(
    owner ? financePath(project.id, "/mailboxes") : null,
  );
  const refresh = () => {
    email.refresh();
    bindings.refresh();
  };
  const action = useMutation(refresh);
  const api = financeApi(project.id);
  return (
    <Panel title={t.mailboxes.title} hint={t.mailboxes.hint}>
      {!owner ? (
        <p className="panel-note">{t.mailboxes.ownerOnlyList}</p>
      ) : (
        <LoadState resources={[email, bindings]}>
          <MailboxList
            t={t}
            rows={bindableMailboxes(
              email.data?.mailboxes ?? [],
              bindings.data?.items ?? [],
            )}
            canManage={owner}
            pending={action.pending}
            onBind={(emailConnectionId, archiveFolder) =>
              action.run(() =>
                api.mailboxes.bind({ emailConnectionId, archiveFolder }),
              )
            }
            onUnbind={(id) => action.run(() => api.mailboxes.unbind(id))}
          />
        </LoadState>
      )}
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Panel>
  );
}

// ------------------------------------------------------ accounts, categories

function Accounts({ t }: { t: FinanceText }) {
  const { project } = useWorkspace();
  const { owner, write } = useFinanceAccess();
  const api = financeApi(project.id);
  const accounts = useResource<{ items: Account[] }>(
    financePath(project.id, "/accounts"),
  );
  const categories = useResource<{ items: Category[] }>(
    financePath(project.id, "/categories"),
  );
  const refresh = () => {
    accounts.refresh();
    categories.refresh();
  };
  const action = useMutation(refresh);
  const [account, setAccount] = useState({
    code: "",
    name: "",
    type: "expense",
  });
  const [category, setCategory] = useState({
    name: "",
    kind: "expense",
    accountId: "",
  });
  const list = accounts.data?.items ?? [];
  const postable = list.filter((a) => a.type === category.kind);
  return (
    <>
      <Panel title={t.accounts.accounts}>
        <LoadState resources={[accounts]}>
          <ul className="settings-rows">
            {list.map((a) => (
              <li key={a.id} className="settings-row">
                <strong>
                  {a.code} {a.name}
                </strong>{" "}
                <Badge>{t.accounts.types[a.type] ?? a.type}</Badge>
                {a.role && (
                  <Badge tone="blue">
                    {t.roles[a.role] ?? t.accounts.system}
                  </Badge>
                )}
                {a.paymentAccount && <Badge>{t.accounts.payment}</Badge>}
                {owner && !a.role && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.pending}
                    onClick={() => action.run(() => api.accounts.archive(a.id))}
                  >
                    {t.accounts.archive}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!list.length && <p className="panel-note">{t.accounts.none}</p>}
          <form
            className="settings-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              action
                .run(() =>
                  api.accounts.create({
                    code: account.code.trim(),
                    name: account.name.trim(),
                    type: account.type as Account["type"],
                  }),
                )
                .then(
                  (ok) => ok && setAccount({ ...account, code: "", name: "" }),
                );
            }}
          >
            <fieldset disabled={!owner}>
              <legend>{t.accounts.add}</legend>
              {!owner && (
                <p className="panel-note">{t.accounts.accountsOwner}</p>
              )}
              <label>
                <span>{t.accounts.code}</span>
                <Input
                  required
                  maxLength={20}
                  value={account.code}
                  onChange={(e) =>
                    setAccount({ ...account, code: e.target.value })
                  }
                />
              </label>
              <label>
                <span>{t.accounts.name}</span>
                <Input
                  required
                  maxLength={120}
                  value={account.name}
                  onChange={(e) =>
                    setAccount({ ...account, name: e.target.value })
                  }
                />
              </label>
              <label>
                <span>{t.accounts.type}</span>
                <select
                  className="input"
                  value={account.type}
                  onChange={(e) =>
                    setAccount({ ...account, type: e.target.value })
                  }
                >
                  {Object.entries(t.accounts.types).map(([key, text]) => (
                    <option key={key} value={key}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            {owner && (
              <Button type="submit" disabled={action.pending}>
                {t.accounts.add}
              </Button>
            )}
          </form>
        </LoadState>
      </Panel>
      <Panel title={t.accounts.categories}>
        <LoadState resources={[categories, accounts]}>
          <ul className="settings-rows">
            {(categories.data?.items ?? []).map((c) => (
              <li key={c.id} className="settings-row">
                <strong>{c.name}</strong>{" "}
                <Badge>{t.accounts.kinds[c.kind] ?? c.kind}</Badge>
                {write && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.pending}
                    onClick={() =>
                      action.run(() => api.categories.archive(c.id))
                    }
                  >
                    {t.accounts.archive}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!categories.data?.items.length && (
            <p className="panel-note">{t.accounts.none}</p>
          )}
          {write && (
            <form
              className="settings-form"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                action
                  .run(() =>
                    api.categories.create({
                      name: category.name.trim(),
                      kind: category.kind as Category["kind"],
                      accountId: category.accountId,
                    }),
                  )
                  .then((ok) => ok && setCategory({ ...category, name: "" }));
              }}
            >
              <label>
                <span>{t.accounts.name}</span>
                <Input
                  required
                  maxLength={120}
                  value={category.name}
                  onChange={(e) =>
                    setCategory({ ...category, name: e.target.value })
                  }
                />
              </label>
              <label>
                <span>{t.accounts.kind}</span>
                <select
                  className="input"
                  value={category.kind}
                  onChange={(e) =>
                    setCategory({
                      ...category,
                      kind: e.target.value,
                      accountId: "",
                    })
                  }
                >
                  {Object.entries(t.accounts.kinds).map(([key, text]) => (
                    <option key={key} value={key}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t.accounts.accounts}</span>
                <select
                  className="input"
                  required
                  value={category.accountId}
                  onChange={(e) =>
                    setCategory({ ...category, accountId: e.target.value })
                  }
                >
                  <option value="" />
                  {postable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={action.pending}>
                {t.accounts.addCategory}
              </Button>
            </form>
          )}
        </LoadState>
        {action.error && <Alert kind="error">{action.error}</Alert>}
      </Panel>
    </>
  );
}

function CostCenters({ t }: { t: FinanceText }) {
  const { project } = useWorkspace();
  const { write } = useFinanceAccess();
  const api = financeApi(project.id);
  const centers = useResource<{ items: CostCenter[] }>(
    financePath(project.id, "/cost-centers"),
  );
  const action = useMutation(centers.refresh);
  const [form, setForm] = useState({ code: "", name: "" });
  return (
    <Panel title={t.costCenters.title} hint={t.costCenters.hint}>
      <LoadState resources={[centers]}>
        <ul className="settings-rows">
          {(centers.data?.items ?? []).map((c) => (
            <li key={c.id} className="settings-row">
              <strong>
                {c.code} {c.name}
              </strong>
              {write && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.pending}
                  onClick={() =>
                    action.run(() => api.costCenters.archive(c.id))
                  }
                >
                  {t.costCenters.archive}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {!centers.data?.items.length && (
          <p className="panel-note">{t.costCenters.none}</p>
        )}
        {write && (
          <form
            className="settings-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              action
                .run(() =>
                  api.costCenters.create({
                    code: form.code.trim(),
                    name: form.name.trim(),
                  }),
                )
                .then((ok) => ok && setForm({ code: "", name: "" }));
            }}
          >
            <label>
              <span>{t.costCenters.code}</span>
              <Input
                required
                maxLength={20}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </label>
            <label>
              <span>{t.costCenters.name}</span>
              <Input
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <Button type="submit" disabled={action.pending}>
              {t.costCenters.add}
            </Button>
          </form>
        )}
      </LoadState>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Panel>
  );
}

// ---------------------------------------------------------- currencies & FX

const PEG = /^\d{1,12}\.\d{1,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^\d{1,12}(\.\d{1,12})?$/;

function Currencies({ t }: { t: FinanceText }) {
  const { project } = useWorkspace();
  const { owner } = useFinanceAccess();
  const api = financeApi(project.id);
  const current = useResource<SettingsResponse>(
    financePath(project.id, "/settings"),
  );
  const rates = useResource<{ items: FxRate[] }>(
    financePath(project.id, "/fx-rates"),
  );
  const save = useMutation(current.refresh);
  const rate = useMutation(rates.refresh);
  const [draft, setDraft] = useState<Partial<FinanceSettings>>({});
  const [manual, setManual] = useState({
    date: "",
    currency: "USD",
    perEur: "",
  });
  if (!current.data)
    return (
      <Panel title={t.currencies.title}>
        <LoadState resources={[current]}>{null}</LoadState>
      </Panel>
    );
  const s = { ...current.data.settings, ...draft };
  const pegOk = PEG.test(s.usdcPeg);
  const toggle = (code: string) => {
    const next = s.currencies.includes(code)
      ? s.currencies.filter((c) => c !== code)
      : [...s.currencies, code];
    setDraft({ ...draft, currencies: next });
  };
  const baseEnabled = s.currencies.includes(s.baseCurrency);
  const manualOk =
    DATE.test(manual.date) &&
    RATE.test(manual.perEur) &&
    Number(manual.perEur) > 0;
  return (
    <>
      <Panel title={t.currencies.title}>
        <form
          className="settings-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save
              .run(() =>
                api.settings.put(
                  {
                    baseCurrency: s.baseCurrency,
                    currencies: s.currencies,
                    usdcPeg: s.usdcPeg,
                    fxSource: s.fxSource,
                  },
                  current.data!.version,
                ),
              )
              .then((ok) => ok && setDraft({}));
          }}
        >
          <fieldset disabled={!owner}>
            <legend>{t.currencies.enabled}</legend>
            {CURRENCIES.map((code) => (
              <label key={code} className="settings-check">
                <input
                  type="checkbox"
                  checked={s.currencies.includes(code)}
                  onChange={() => toggle(code)}
                />
                <span>{code}</span>
              </label>
            ))}
            <p className="panel-note">{t.currencies.enabledHint}</p>
          </fieldset>
          <label>
            <span>{t.currencies.base}</span>
            <select
              className="input"
              disabled={!owner}
              value={s.baseCurrency}
              onChange={(e) =>
                setDraft({ ...draft, baseCurrency: e.target.value })
              }
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <small>{t.currencies.baseHint}</small>
          </label>
          <label>
            <span>{t.currencies.peg}</span>
            <Input
              disabled={!owner}
              value={s.usdcPeg}
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, usdcPeg: e.target.value })}
            />
            <small>
              {pegOk ? t.currencies.pegHint : t.currencies.pegInvalid}
            </small>
          </label>
          <label>
            <span>{t.currencies.source}</span>
            <select
              className="input"
              disabled={!owner}
              value={s.fxSource}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fxSource: e.target.value as "ecb" | "manual",
                })
              }
            >
              {Object.entries(t.currencies.sources).map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          {owner && (
            <Button
              type="submit"
              disabled={save.pending || !pegOk || !baseEnabled}
            >
              {t.save}
            </Button>
          )}
          {save.success && <Alert kind="success">{t.saved}</Alert>}
          {save.error && <Alert kind="error">{save.error}</Alert>}
          {!owner && <p className="panel-note">{t.ownerOnly}</p>}
        </form>
      </Panel>
      <Panel title={t.currencies.manualTitle} hint={t.currencies.manualHint}>
        <form
          className="settings-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rate
              .run(() => api.fxRates.set(manual))
              .then((ok) => ok && setManual({ ...manual, perEur: "" }));
          }}
        >
          <fieldset disabled={!owner}>
            <label>
              <span>{t.currencies.date}</span>
              <Input
                type="date"
                value={manual.date}
                onChange={(e) => setManual({ ...manual, date: e.target.value })}
              />
            </label>
            <label>
              <span>{t.currencies.currency}</span>
              <select
                className="input"
                value={manual.currency}
                onChange={(e) =>
                  setManual({ ...manual, currency: e.target.value })
                }
              >
                {CURRENCIES.filter((c) => c !== "EUR").map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.currencies.perEur}</span>
              <Input
                inputMode="decimal"
                value={manual.perEur}
                onChange={(e) =>
                  setManual({ ...manual, perEur: e.target.value })
                }
              />
            </label>
          </fieldset>
          {owner && (
            <Button type="submit" disabled={rate.pending || !manualOk}>
              {t.currencies.setRate}
            </Button>
          )}
          {!manualOk && manual.perEur !== "" && (
            <p className="panel-note">{t.currencies.rateInvalid}</p>
          )}
          {rate.success && (
            <Alert kind="success">{t.currencies.rateSaved}</Alert>
          )}
          {rate.error && <Alert kind="error">{rate.error}</Alert>}
        </form>
        <h3>{t.currencies.recent}</h3>
        <LoadState resources={[rates]}>
          {rates.data?.items.length ? (
            <ul className="settings-rows">
              {rates.data.items.slice(0, 10).map((r) => (
                <li key={r.id} className="settings-row">
                  {r.date.slice(0, 10)} <strong>{r.currency}</strong> {r.perEur}{" "}
                  <Badge>{r.source}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">{t.currencies.noRates}</p>
          )}
        </LoadState>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------ AI extraction

/** The consent and the daily ceiling (in USD), as a controlled form. */
export function AiExtractionForm({
  t,
  enabled,
  ceiling,
  disabled,
  pending,
  error,
  onToggle,
  onCeiling,
  onSubmit,
}: {
  t: FinanceText;
  enabled: boolean;
  ceiling: string;
  disabled: boolean;
  pending: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onCeiling: (text: string) => void;
  onSubmit: () => void;
}) {
  const micros = unitsToMicros(ceiling);
  const ceilingOk = micros !== null && micros <= MAX_CEILING_MICROS;
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={disabled}>
        <legend>{t.ai.consent}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={enabled}
            aria-describedby="finance-ai-consent-hint"
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{enabled ? t.ai.on : t.ai.off}</span>
        </label>
        <p id="finance-ai-consent-hint" className="panel-note">
          {t.ai.consentBody}
        </p>
        <label>
          <span>{t.ai.ceiling}</span>
          <Input
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => onCeiling(e.target.value)}
          />
          <small>{ceilingOk ? t.ai.ceilingHint : t.ai.ceilingInvalid}</small>
        </label>
      </fieldset>
      {!disabled && (
        <Button type="submit" disabled={pending || !ceilingOk}>
          {t.save}
        </Button>
      )}
      {disabled && <p className="panel-note">{t.ownerOnly}</p>}
      {error && <Alert kind="error">{error}</Alert>}
    </form>
  );
}

function AiExtraction({ t }: { t: FinanceText }) {
  const { project } = useWorkspace();
  const { owner } = useFinanceAccess();
  const api = financeApi(project.id);
  const current = useResource<SettingsResponse>(
    financePath(project.id, "/settings"),
  );
  const save = useMutation(current.refresh);
  const [draft, setDraft] = useState<{ enabled?: boolean; ceiling?: string }>(
    {},
  );
  if (!current.data)
    return (
      <Panel title={t.ai.title}>
        <LoadState resources={[current]}>{null}</LoadState>
      </Panel>
    );
  const s = current.data.settings;
  return (
    <Panel title={t.ai.title}>
      <AiExtractionForm
        t={t}
        enabled={draft.enabled ?? s.aiExtraction === "on"}
        ceiling={draft.ceiling ?? microsToUnits(s.aiDailyCeilingMicros)}
        disabled={!owner}
        pending={save.pending}
        error={save.error}
        onToggle={(enabled) => setDraft({ ...draft, enabled })}
        onCeiling={(ceiling) => setDraft({ ...draft, ceiling })}
        onSubmit={() => {
          const micros = unitsToMicros(
            draft.ceiling ?? microsToUnits(s.aiDailyCeilingMicros),
          );
          if (micros === null || micros > MAX_CEILING_MICROS) return;
          save
            .run(() =>
              api.settings.put(
                {
                  aiExtraction:
                    (draft.enabled ?? s.aiExtraction === "on") ? "on" : "off",
                  aiDailyCeilingMicros: micros,
                },
                current.data!.version,
              ),
            )
            .then((ok) => ok && setDraft({}));
        }}
      />
      {save.success && <Alert kind="success">{t.saved}</Alert>}
    </Panel>
  );
}

// ------------------------------------------------------------------ sections

function section(
  key: string,
  order: number,
  tabLabel: (t: FinanceText) => string,
  Body: (props: { t: FinanceText }) => ReactNode,
): SettingsSection {
  return {
    tab: {
      key,
      label: {
        en: tabLabel(financeText("en")),
        de: tabLabel(financeText("de")),
      },
      order,
    },
    order: 10,
    useSection() {
      const { locale } = useWorkspace();
      return { content: <Body t={financeText(locale)} /> };
    },
  };
}

/** Finance's settings sections, in the order of the module's group. */
export const financeSettings: readonly SettingsSection[] = [
  section("finance-mailboxes", 40, (t) => t.mailboxes.tab, Mailboxes),
  section("finance-accounts", 41, (t) => t.accounts.tab, Accounts),
  section("finance-cost-centers", 42, (t) => t.costCenters.tab, CostCenters),
  section("finance-currencies", 43, (t) => t.currencies.tab, Currencies),
  section("finance-ai", 44, (t) => t.ai.tab, AiExtraction),
];
