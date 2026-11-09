import type { WebmailRights } from "./api";

// The five rights of a mailbox grant (ADR 0026, E5). No grant means no access;
// project roles imply nothing here, for owners included.

export const RIGHTS = [
  "canRead",
  "canSend",
  "canOrganize",
  "canConvert",
  "canManage",
] as const;
export type Right = (typeof RIGHTS)[number];

export const NO_RIGHTS: WebmailRights = {
  canRead: false,
  canSend: false,
  canOrganize: false,
  canConvert: false,
  canManage: false,
};

export const rightsOf = (grant: WebmailRights | null): WebmailRights =>
  grant ? { ...NO_RIGHTS, ...grant } : NO_RIGHTS;

export const hasAnyRight = (rights: WebmailRights) =>
  RIGHTS.some((right) => rights[right]);

/**
 * The rights after one change. Read carries the others: removing it removes
 * them all, and another right cannot be added without it.
 */
export function changeRight(
  rights: WebmailRights,
  right: Right,
  on: boolean,
): WebmailRights {
  if (right === "canRead")
    return on ? { ...rights, canRead: true } : { ...NO_RIGHTS };
  if (on && !rights.canRead) return rights;
  return { ...rights, [right]: on };
}

/** A right the member cannot switch on yet; one already set can be removed. */
export const rightLocked = (rights: WebmailRights, right: Right) =>
  right !== "canRead" && !rights.canRead && !rights[right];
