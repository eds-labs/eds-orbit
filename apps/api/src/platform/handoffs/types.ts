import type { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  Actor,
  ObjectRef,
  PermissionDef,
} from "../../../../../packages/module-contracts/src/index.ts";

/**
 * A handoff target (ADR 0017 P-3): a module turns a task into work it owns,
 * such as a research run or a draft campaign request, without the handing
 * module importing it. Registered as "<module>.<name>".
 */
export type HandoffTarget = {
  label: { en: string; de: string };
  /** What the member must be allowed in the target's module; checked again at approval. */
  permission: PermissionDef;
  /**
   * `W0_internal`: an owner or editor decides. `P_proposal`: paid or
   * external work; the owner decides every time.
   */
  risk: "W0_internal" | "P_proposal";
  /** The brief the target takes, strict. */
  input: z.ZodObject;
  /** The most the handoff may spend, in micros. */
  costCeilingMicros?(input: unknown): number;
  /**
   * Starts the work in the approval's transaction. `handoffId` names the
   * handoff record; a target that creates no object of its own returns it
   * as the target (`work.handoff`). The target later reports its progress
   * with `reportHandoffStatus`.
   */
  create(
    tx: DbTx,
    scope: Scope,
    from: ObjectRef,
    input: unknown,
    actor: Actor,
    handoffId: string,
  ): Promise<{ target: ObjectRef }>;
};

export const HANDOFF_STATUSES = ["started", "finished", "failed"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
