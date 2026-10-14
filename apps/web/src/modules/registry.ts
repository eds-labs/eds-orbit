import {
  Activity,
  CircleCheck,
  Home,
  Link2,
  MessageCircle,
  Settings,
} from "lucide-react";
import { labels } from "@/lib/i18n";
import type { Label, WebRegistry } from "@/platform/shell/types";
import { ProjectHome } from "@/platform/shell/home";
import { OrbitChat } from "@/components/chat";
import {
  Connectors,
  Operations,
  ProjectSettings,
} from "@/components/management";
import { ApprovalInbox } from "@/modules/marketing/work";
import { knowledgeWeb } from "./knowledge/manifest";
import { marketingWeb } from "./marketing/manifest";

// Composition root of the web app (ADR 0009 AD-13): the only place that knows
// both the platform pages and every module, like apps/api/src/modules/registry.ts
// on the server. The shell receives this registry and imports no module.

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

export const webRegistry: WebRegistry = {
  platform: [
    {
      key: "home",
      path: "",
      component: ProjectHome,
      nav: { label: label("home"), icon: Home, order: 0, mobile: true },
    },
    {
      key: "chat",
      path: "assistant",
      component: OrbitChat,
      nav: {
        label: label("chat"),
        icon: MessageCircle,
        order: 20,
        mobile: true,
      },
      legacyPaths: ["/chat"],
    },
    {
      // Transitional: today's inbox lists marketing items; WP2.3 makes it a
      // platform inbox with items contributed by the modules.
      key: "approvals",
      path: "approvals",
      component: ApprovalInbox,
      requiresModule: "marketing",
      nav: { label: label("approvals"), icon: CircleCheck, order: 70 },
      legacyPaths: ["/approvals"],
    },
    {
      key: "connectors",
      path: "connectors",
      component: Connectors,
      nav: { label: label("connectors"), icon: Link2, order: 100 },
      legacyPaths: ["/connectors"],
    },
    {
      key: "operations",
      path: "operations",
      component: Operations,
      nav: { label: label("operations"), icon: Activity, order: 110 },
      legacyPaths: ["/operations"],
    },
    {
      key: "settings",
      path: "settings",
      component: ProjectSettings,
      nav: { label: label("settings"), icon: Settings, order: 120 },
      legacyPaths: ["/settings"],
    },
  ],
  // Same order as the server registry (apps/api/src/modules/registry.ts).
  modules: [knowledgeWeb, marketingWeb],
};
