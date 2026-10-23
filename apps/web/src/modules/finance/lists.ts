import { useState } from "react";
import { ApiError, useResource } from "@/lib/api";
import {
  financePath,
  query,
  type Account,
  type Category,
  type CostCenter,
  type Counterparty,
  type SettingsResponse,
} from "./api";
import type { FinanceText } from "./labels";

// Shared by the management pages: the master data they choose from, kept
// across refetches, and the readable text of an API error.

type Items<T> = { items: T[] };

/** The last non-null value: a refetch never empties what is shown. */
export function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/**
 * Accounts, categories, cost centers, counterparties and the settings of a
 * project (archived rows included, so old bookings stay readable). `loading`
 * is true until every list arrived once.
 */
export function useMasterData(projectId: string) {
  const path = (rest: string) => financePath(projectId, rest);
  const archived = query({ includeArchived: true });
  const accounts = useResource<Items<Account>>(path(`/accounts${archived}`));
  const categories = useResource<Items<Category>>(
    path(`/categories${archived}`),
  );
  const costCenters = useResource<Items<CostCenter>>(
    path(`/cost-centers${archived}`),
  );
  const counterparties = useResource<Items<Counterparty>>(
    path("/counterparties"),
  );
  const settings = useResource<SettingsResponse>(path("/settings"));
  const last = {
    accounts: useLast(accounts.data),
    categories: useLast(categories.data),
    costCenters: useLast(costCenters.data),
    counterparties: useLast(counterparties.data),
    settings: useLast(settings.data),
  };
  const all = [accounts, categories, costCenters, counterparties, settings];
  return {
    accounts: last.accounts?.items ?? [],
    categories: last.categories?.items ?? [],
    costCenters: last.costCenters?.items ?? [],
    counterparties: last.counterparties?.items ?? [],
    settings: last.settings?.settings ?? null,
    loading: Object.values(last).some((v) => v === null),
    error: all.find((r) => r.error)?.error ?? null,
    retry: () => all.forEach((r) => r.refresh()),
  };
}

/**
 * The readable text of a failed request: a known code, else the code's
 * words. Also takes `useMutation`'s error, the code's words as a string.
 */
export function errorText(error: unknown, t: FinanceText): string {
  if (error instanceof ApiError)
    return t.manage.errors[error.code] ?? error.message;
  if (typeof error === "string")
    return t.manage.errors[error.replaceAll(" ", "_")] ?? error;
  return error instanceof Error ? error.message : t.manage.requestFailed;
}

/** The code of a failed request, or null. */
export const errorCode = (error: unknown): string | null =>
  error instanceof ApiError ? error.code : null;
