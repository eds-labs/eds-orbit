"use client";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import type { CostCenter } from "./api";
import type { FinanceText } from "./labels";

// The split of one booking line over cost centers. A person edits shares
// as percentages with up to two decimals; the API takes basis points
// (10000 = 100 %). Percent text becomes basis points with string math only,
// so "33.33" is exactly 3333 and never passes through a float.

export const FULL_BP = 10_000;

/** One row as typed: the cost center id ("" while unchosen) and its share. */
export type AllocationRow = { costCenterId: string; percent: string };
export type Allocation = Array<{ costCenterId: string; bp: number }>;

/** "33.33" (or "33,33") as 3333 basis points; null when not 0–100 with ≤ 2 decimals. */
export function percentToBp(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp <= FULL_BP ? bp : null;
}

/** 3333 basis points as "33.33". */
export function bpToPercent(bp: number): string {
  return `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, "0")}`;
}

/** n equal shares in basis points; the remainder goes to the last one. */
export function evenSplit(n: number): number[] {
  if (n <= 0) return [];
  const share = Math.floor(FULL_BP / n);
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? FULL_BP - share * (n - 1) : share,
  );
}

/** The rows with their shares replaced by an even split. */
export function evenRows(rows: readonly AllocationRow[]): AllocationRow[] {
  const shares = evenSplit(rows.length);
  return rows.map((row, i) => ({ ...row, percent: bpToPercent(shares[i]!) }));
}

export type AllocationProblem = "percent" | "center" | "duplicate" | "sum";

/**
 * The allocation the rows describe, or the first problem that blocks
 * submitting it. No rows is a valid empty allocation (no cost center).
 */
export function allocationOf(rows: readonly AllocationRow[]): {
  allocation: Allocation | null;
  sumBp: number | null;
  problem: AllocationProblem | null;
} {
  if (rows.length === 0) return { allocation: [], sumBp: 0, problem: null };
  const shares = rows.map((row) => percentToBp(row.percent));
  if (shares.some((bp) => bp === null))
    return { allocation: null, sumBp: null, problem: "percent" };
  const sumBp = shares.reduce((sum: number, bp) => sum + bp!, 0);
  const problem: AllocationProblem | null = rows.some((r) => !r.costCenterId)
    ? "center"
    : new Set(rows.map((r) => r.costCenterId)).size !== rows.length
      ? "duplicate"
      : sumBp !== FULL_BP
        ? "sum"
        : null;
  return {
    allocation: problem
      ? null
      : rows.map((row, i) => ({
          costCenterId: row.costCenterId,
          bp: shares[i]!,
        })),
    sumBp,
    problem,
  };
}

/** The text of an allocation problem. */
export function allocationMessage(
  t: FinanceText,
  problem: AllocationProblem,
): string {
  const a = t.allocation;
  return problem === "percent"
    ? a.percentInvalid
    : problem === "center"
      ? a.centerMissing
      : problem === "duplicate"
        ? a.duplicate
        : a.sumInvalid;
}

/** Stored basis points (a draft or a suggestion) as editable rows. */
export function rowsOf(allocation: unknown): AllocationRow[] {
  if (!Array.isArray(allocation)) return [];
  return allocation.flatMap((part) => {
    const p = part as { costCenterId?: unknown; bp?: unknown };
    return typeof p.costCenterId === "string" &&
      typeof p.bp === "number" &&
      Number.isInteger(p.bp)
      ? [{ costCenterId: p.costCenterId, percent: bpToPercent(p.bp) }]
      : [];
  });
}

/**
 * The editor of one line's split. Archived cost centers are not offered,
 * except one a stored row already names (so the row stays readable); the
 * server refuses booking on it.
 */
export function AllocationEditor({
  t,
  id,
  rows,
  costCenters,
  disabled,
  onChange,
}: {
  t: FinanceText;
  /** Prefix for the element ids, unique per line. */
  id: string;
  rows: readonly AllocationRow[];
  costCenters: readonly CostCenter[];
  disabled?: boolean;
  onChange: (rows: AllocationRow[]) => void;
}) {
  const a = t.allocation;
  const state = allocationOf(rows);
  const offered = (current: string) =>
    costCenters.filter((c) => !c.archivedAt || c.id === current);
  const set = (index: number, change: Partial<AllocationRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const message = state.problem ? allocationMessage(t, state.problem) : null;
  return (
    <fieldset className="finance-allocation" disabled={disabled}>
      <legend>{a.legend}</legend>
      {rows.length === 0 ? (
        <p className="panel-note">{a.none}</p>
      ) : (
        <ul className="finance-allocation-rows">
          {rows.map((row, index) => (
            <li key={index}>
              <label>
                <span>{a.center}</span>
                <select
                  id={`${id}-center-${index}`}
                  className="input"
                  value={row.costCenterId}
                  onChange={(e) => set(index, { costCenterId: e.target.value })}
                >
                  <option value="">{a.centerChoose}</option>
                  {offered(row.costCenterId).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{a.percent}</span>
                <input
                  id={`${id}-percent-${index}`}
                  className="input"
                  inputMode="decimal"
                  value={row.percent}
                  onChange={(e) => set(index, { percent: e.target.value })}
                />
              </label>
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={a.remove}
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 aria-hidden size={14} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <p className="finance-allocation-sum" aria-live="polite">
          {a.sum.replace(
            "{sum}",
            state.sumBp === null ? "—" : bpToPercent(state.sumBp),
          )}
        </p>
      )}
      {message && (
        <p
          className="finance-problem"
          role="alert"
          data-problem={state.problem}
        >
          {message}
        </p>
      )}
      {!disabled && (
        <div className="settings-row-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([...rows, { costCenterId: "", percent: "" }])
            }
          >
            <Plus aria-hidden size={14} />
            {a.add}
          </Button>
          {rows.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(evenRows(rows))}
            >
              {a.even}
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
