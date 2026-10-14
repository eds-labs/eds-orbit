import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type {
  ActionRequestRenderer,
  ChatExtension,
} from "@/platform/assistant/extensions";

// The web side of the module contract (plans/orbit-modularization/03 §10).
// It lives in the web app rather than packages/module-contracts because it
// references React components; the server never reads it.

export type Label = { en: string; de: string };

/** A navigation entry; views without one are reachable by URL only. */
export type NavEntry = {
  label: Label;
  icon: LucideIcon;
  /** Position in the sidebar, shared by the platform and all modules. */
  order: number;
  /** Shown in the mobile bottom bar, optionally with a shorter label. */
  mobile?: true | Label;
};

/** A page of the platform or of a module. */
export type ViewDef = {
  /** Unique across the app; also the stable name used by legacy links. */
  key: string;
  /** Path below the owner's root: "" for the root itself, else one segment. */
  path: string;
  component: ComponentType;
  nav?: NavEntry;
  /** Paths from before WP1.7 that redirect here, such as "/missions". */
  legacyPaths?: readonly string[];
};

/** The web manifest of a module, mounted at /p/:projectId/<id>. */
export type WebModule = {
  /** Same id as the server module (GET /api/projects/:id/modules). */
  id: string;
  displayName: Label;
  description: Label;
  views: readonly ViewDef[];
  /** A section of the project home, ordered by homeOrder. */
  home?: ComponentType;
  homeOrder?: number;
  /** Message cards and sections of the platform chat (WP2.3). */
  chat?: ChatExtension;
  /** The approvals inbox view of the module's action request types (WP2.3). */
  actionRequests?: Readonly<Record<string, ActionRequestRenderer>>;
};

/** Everything the shell can show, assembled by the composition root. */
export type WebRegistry = {
  /** Platform pages, mounted at /p/:projectId/<path>. */
  platform: readonly ViewDef[];
  modules: readonly WebModule[];
};
