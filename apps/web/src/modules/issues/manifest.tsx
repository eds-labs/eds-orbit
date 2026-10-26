import { Bug, LayoutDashboard, ListFilter, Rocket } from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { issuesActionRequests } from "./action-requests";
import { issuesAttention } from "./attention";
import { issuesText } from "./labels";
import { IssueListView } from "./list";
import { IssuesHome, IssuesOverview } from "./overview";
import { ReleasesView } from "./releases";
import { issuesSettings } from "./settings";
import { TriageView } from "./triage";

const nav = (key: keyof ReturnType<typeof issuesText>["nav"]) => ({
  en: issuesText("en").nav[key],
  de: issuesText("de").nav[key],
});

/**
 * The issue center in the web shell (ADR 0018): overview, list with the
 * issue detail (?issue=<id>), triage and releases, a settings section and
 * a home card. Opt-in: shown only where the server lists the module as
 * enabled (ORBIT_ISSUES and the project row).
 */
export const issuesWeb: WebModule = {
  id: "issues",
  optIn: true,
  displayName: { en: "Issues", de: "Issues" },
  description: {
    en: "Product issues from Support and connected systems, their tasks and releases.",
    de: "Produkt-Issues aus Support und verbundenen Systemen, ihre Aufgaben und Releases.",
  },
  home: IssuesHome,
  homeOrder: 9,
  // After Support (20), plan §5.
  groupOrder: 25,
  settings: issuesSettings,
  attention: issuesAttention,
  actionRequests: issuesActionRequests,
  views: [
    { key: "issues", path: "", component: IssuesOverview, nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 } },
    { key: "issues-list", path: "list", component: IssueListView, nav: { label: nav("list"), icon: Bug, order: 10 } },
    { key: "issues-triage", path: "triage", component: TriageView, nav: { label: nav("triage"), icon: ListFilter, order: 20 } },
    { key: "issues-releases", path: "releases", component: ReleasesView, nav: { label: nav("releases"), icon: Rocket, order: 30 } },
  ],
};
