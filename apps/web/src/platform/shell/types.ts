import type { ComponentType, ReactNode } from "react";
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

/**
 * A section of the project settings (WP2.3b). Sections join the tab they
 * name; a module section shows above the platform's content of that tab.
 */
export type SettingsSection = {
  tab: { key: string; label: Label; order: number };
  /** Position among the modules' sections of the tab. */
  order: number;
  /**
   * A hook, called on every render of the settings page in registry order:
   * the content, or null while the section is hidden. `label` overrides the
   * tab's label; `notice` shows above every tab (e.g. a load error).
   */
  useSection(): {
    content: ReactNode;
    label?: Label;
    notice?: ReactNode;
  } | null;
};

/** A connection provider a module manages on the connectors page (WP2.3b). */
export type ConnectorProvider = {
  id: string;
  name: string;
  description: string;
  capability: string;
  /** A note shown whether or not the provider is configured. */
  note?: string;
  /** Details shown below the state of a configured connector. */
  Details?: ComponentType<{ connector: Record<string, any> }>;
  /** Owner actions beside "Configure" for a configured connector. */
  Actions?: ComponentType<{ connector: Record<string, any> }>;
  /** Label of the capability check; null for providers without one. */
  checkLabel: string | null;
  /** Extra fields of the generic credential form. */
  fields?: ReadonlyArray<{ name: string; label: string; required: boolean }>;
  /** Replaces the generic credential form. */
  Configure?: ComponentType<{ onClose(): void }>;
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
  /** Sections of the project settings (WP2.3b). */
  settings?: readonly SettingsSection[];
  /** Setup links of the settings overview, before the platform's own. */
  setupLinks?: readonly ComponentType[];
  /** Providers and extra cards of the connectors page (WP2.3b). */
  connectors?: {
    providers?: readonly ConnectorProvider[];
    /** Cards shown after the platform's own connections. */
    extras?: readonly ComponentType[];
  };
};

/** Everything the shell can show, assembled by the composition root. */
export type WebRegistry = {
  /** Platform pages, mounted at /p/:projectId/<path>. */
  platform: readonly ViewDef[];
  modules: readonly WebModule[];
};
