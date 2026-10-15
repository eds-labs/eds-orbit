import type { ComponentType } from "react";

/** What the platform chat lends a module's chat parts (WP2.3). */
export type ChatHost = {
  /** The conversation as GET …/chat/conversations/:id returns it. */
  conversation: Record<string, any> | null;
  pending: boolean;
  de: boolean;
  /**
   * Runs one action with the chat's pending state and error line, then
   * reloads the conversation. A returned message is shown as the error.
   */
  run(task: () => Promise<string | void>, failure: string): Promise<void>;
};

/** A module's parts of the platform chat (WP2.3, plans 03 §10). */
export type ChatExtension = {
  /** Renderers of message cards by kind, shown above the generic cards. */
  messageCards?: Readonly<
    Record<string, ComponentType<{ card: any; host: ChatHost }>>
  >;
  /** Rendered below the messages, above the proposals. */
  afterMessages?: ComponentType<{ host: ChatHost }>;
  /** Keeps the conversation refreshing while this is true. */
  busy?(conversation: Record<string, any>): boolean;
};

/** An owner's decision on one action request, as the inbox renders it. */
export type ActionRequestRenderer = {
  /** False to fall back to the generic request view. */
  accepts(item: Record<string, any>): boolean;
  component: ComponentType<{
    item: Record<string, any>;
    de: boolean;
    pending: boolean;
    decide(decision: "approve" | "reject", imageRightsConsent?: boolean): void;
  }>;
};
