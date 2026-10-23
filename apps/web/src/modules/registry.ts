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
import { Decisions } from "@/platform/shell/decisions";
import { ProjectHome } from "@/platform/shell/home";
import { OrbitChat } from "@/components/chat";
import {
  Connectors,
  Operations,
  ProjectSettings,
} from "@/components/management";
import { ConnectErrorView, ConnectView } from "@/platform/connect/connect-view";
import { AccountView } from "@/platform/account/account-view";
import {
  ConfirmEmailView,
  InviteView,
  ResetPasswordView,
} from "@/platform/account/token-pages";
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
  platform_provider_budget: (item, locale) => {
    const spent = usd(
      typeof item.params.spentMicros === "number"
        ? item.params.spentMicros
        : null,
    );
    const stop = usd(
      typeof item.params.stopMicros === "number"
        ? item.params.stopMicros
        : null,
    );
    const stopped = item.params.level === "stopped";
    return locale === "de"
      ? {
          title: stopped
            ? `Claude-Budget erschöpft: ${spent} von ${stop}`
            : `Claude-Budget: ${spent} von ${stop} verbraucht`,
          detail: stopped
            ? "Keine weiteren Claude-Aufrufe bis zum nächsten Abrechnungszeitraum oder bis das Budget angehoben wird."
            : "Berechneter Verbrauch dieses Abrechnungszeitraums; der Guthabenstand wird nicht live abgeglichen.",
          action: { en: "Review", de: "Prüfen" },
        }
      : {
          title: stopped
            ? `Claude budget exhausted: ${spent} of ${stop}`
            : `Claude budget: ${spent} of ${stop} used`,
          detail: stopped
            ? "No further Claude calls until the next billing period or a higher budget."
            : "Orbit's calculated spend this billing period; the credit balance is not synchronized live.",
          action: { en: "Review", de: "Prüfen" },
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
      key: "decisions",
      path: "decisions",
      component: Decisions,
      navGroup: "project",
      nav: {
        label: { en: "App approvals", de: "App-Freigaben" },
        icon: CircleCheck,
        order: 95,
      },
      legacyPaths: ["/decisions"],
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
    // The user's own account and the one-time link pages (ADR 0013).
    {
      key: "account",
      path: "account",
      component: AccountView,
      title: label("accountTitle"),
      session: "required",
    },
    {
      key: "account-confirm-email",
      path: "account/confirm-email",
      component: ConfirmEmailView,
      title: label("confirmEmailTitle"),
      session: "required",
    },
    {
      key: "invite",
      path: "invite",
      component: InviteView,
      title: label("inviteTitle"),
      session: "none",
    },
    {
      key: "reset-password",
      path: "reset-password",
      component: ResetPasswordView,
      title: label("resetPasswordTitle"),
      session: "none",
    },
  ],
  // Same order as the server registry (apps/api/src/modules/registry.ts).
  modules: [knowledgeWeb, marketingWeb, supportWeb],
};
