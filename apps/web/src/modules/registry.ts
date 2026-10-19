import {
  Activity,
  CircleCheck,
  Home,
  Link2,
  MessageCircle,
  Settings,
} from "lucide-react";
import { usd } from "@/lib/api";
import { labels } from "@/lib/i18n";
import type {
  AttentionRenderer,
  Label,
  WebRegistry,
} from "@/platform/shell/types";
import { ProjectHome } from "@/platform/shell/home";
import { OrbitChat } from "@/components/chat";
import {
  Connectors,
  Operations,
  ProjectSettings,
} from "@/components/management";
import { ConnectErrorView, ConnectView } from "@/platform/connect/connect-view";
import { ApprovalInbox } from "@/modules/marketing/work";
import { knowledgeWeb } from "./knowledge/manifest";
import { marketingWeb } from "./marketing/manifest";
import { supportWeb } from "./support/manifest";

// Composition root of the web app (ADR 0009 AD-13): the only place that knows
// both the platform pages and every module, like apps/api/src/modules/registry.ts
// on the server. The shell receives this registry and imports no module.

const label = (key: keyof typeof labels.en): Label => ({
  en: labels.en[key],
  de: labels.de[key],
});

const CHECK: Label = { en: "Check", de: "Prüfen" };

/** Texts of the platform's own attention items (UI restructure §4.2). */
const platformAttention: Readonly<Record<string, AttentionRenderer>> = {
  platform_worker_down: (_item, locale) =>
    locale === "de"
      ? {
          title: "Worker antwortet nicht",
          detail: "Jobs und Agentenläufe warten.",
          action: CHECK,
        }
      : {
          title: "Worker not responding",
          detail: "Jobs and agent runs are waiting.",
          action: CHECK,
        },
  platform_cost_unknown: (item, locale) => {
    const micros = item.params.micros;
    const amount = usd(typeof micros === "number" ? micros : null);
    return locale === "de"
      ? {
          title: `KI-Kosten unklar: ${amount}`,
          detail: "Reservierungen dieses Monats mit unklarem Ausgang.",
          action: CHECK,
        }
      : {
          title: `AI cost unclear: ${amount}`,
          detail: "Reservations this month with an unknown outcome.",
          action: CHECK,
        };
  },
  platform_action_request: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${n === 1 ? "Entscheidung wartet" : "Entscheidungen warten"} auf dich`
          : `${n} decision${n === 1 ? " waits" : "s wait"} for you`,
      action: { en: "Decide", de: "Entscheiden" },
    };
  },
};

export const webRegistry: WebRegistry = {
  platform: [
    {
      key: "home",
      path: "",
      component: ProjectHome,
      navGroup: "top",
      nav: {
        label: label("home"),
        icon: Home,
        order: 0,
        mobile: true,
        mobileRank: 0,
      },
    },
    {
      key: "chat",
      path: "assistant",
      component: OrbitChat,
      navGroup: "top",
      nav: {
        label: label("chat"),
        icon: MessageCircle,
        order: 20,
        mobile: true,
        mobileRank: 10,
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
      navGroup: "marketing",
      nav: {
        label: label("approvals"),
        icon: CircleCheck,
        order: 45,
        mobile: true,
        mobileRank: 30,
      },
      legacyPaths: ["/approvals"],
    },
    {
      key: "connectors",
      path: "connectors",
      component: Connectors,
      navGroup: "project",
      nav: { label: label("connectors"), icon: Link2, order: 100 },
      legacyPaths: ["/connectors"],
    },
    {
      key: "operations",
      path: "operations",
      component: Operations,
      navGroup: "project",
      nav: { label: label("operations"), icon: Activity, order: 110 },
      legacyPaths: ["/operations"],
    },
    {
      key: "settings",
      path: "settings",
      component: ProjectSettings,
      navGroup: "project",
      nav: { label: label("settings"), icon: Settings, order: 120 },
      legacyPaths: ["/settings"],
    },
  ],
  attention: platformAttention,
  // The OAuth authorization of MCP clients (Track M, WP-M1): Better Auth sends
  // the browser here; the pages sit outside every project.
  standalone: [
    {
      key: "connect",
      path: "connect",
      component: ConnectView,
      title: label("connectTitle"),
      session: "required",
    },
    {
      key: "connect-login",
      path: "connect/login",
      component: ConnectView,
      title: label("connectTitle"),
      session: "required",
      oauthLogin: true,
    },
    {
      key: "connect-error",
      path: "connect/error",
      component: ConnectErrorView,
      title: label("connectErrorTitle"),
      session: "none",
    },
  ],
  // Same order as the server registry (apps/api/src/modules/registry.ts).
  modules: [knowledgeWeb, marketingWeb, supportWeb],
};
