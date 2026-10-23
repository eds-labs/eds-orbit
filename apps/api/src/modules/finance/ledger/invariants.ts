import { DomainError } from "../../../shared.ts";
import type { DraftLine } from "./posting.ts";

/**
 * Checks what the database checks again at commit (spec §4): at least two
 * lines, every amount and base amount positive (the sign is the side), and
 * base-currency debits equal credits. Throws 422 FINANCE_ENTRY_UNBALANCED.
 * The error carries no amounts.
 */
export function assertBalanced(lines: readonly DraftLine[]): void {
  const unbalanced = () => new DomainError("FINANCE_ENTRY_UNBALANCED", 422);
  if (lines.length < 2) throw unbalanced();
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.amountMicros <= 0n || line.baseAmountMicros <= 0n) throw unbalanced();
    if (line.side === "debit") debits += line.baseAmountMicros;
    else if (line.side === "credit") credits += line.baseAmountMicros;
    else throw unbalanced();
  }
  if (debits !== credits) throw unbalanced();
}
