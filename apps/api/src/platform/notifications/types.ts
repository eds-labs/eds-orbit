import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { TelegramButton } from "../../../../../packages/connectors/src/index.ts";

/** One message for the owner's bot, rendered when its job runs. */
export type NotificationMessage = {
  text: string;
  /** Shown under the photo when the text is too long for a caption. */
  header: string;
  buttons: TelegramButton[];
  /**
   * The photo, read outside the transaction (it may live in Drive). A
   * failure or null sends the text alone.
   */
  image?: () => Promise<Uint8Array | null>;
};

/**
 * Renders one notification of a kind the module registered, from the state
 * when the job runs; `{skip}` sends nothing and records the reason.
 */
export type NotificationRender = (
  tx: DbTx,
  scope: Scope,
  kind: string,
  ref: string,
) => Promise<NotificationMessage | { skip: string }>;

/** The notification kinds a module sends and how it renders them (WP2.5b). */
export type NotificationContribution = {
  /** Kind names, unique across modules: `[a-z_]+`. */
  kinds: readonly string[];
  render: NotificationRender;
};
