import {
  CalendarCheck,
  Columns3,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  UserRoundCheck,
} from "lucide-react";
import type { WebModule } from "@/platform/shell/types";
import { workActionRequests } from "./action-requests";
import { workAttention } from "./attention";
import { BoardView } from "./board";
import { InitiativesView } from "./initiatives";
import { workText } from "./labels";
import { workSettings } from "./settings";
import { TaskListView } from "./tasks";
import { MilestonesView, MyTasksView, WorkHome, WorkOverview } from "./views";

const nav = (key: keyof ReturnType<typeof workText>["nav"]) => ({
  en: workText("en").nav[key],
  de: workText("de").nav[key],
});

/**
 * Project management in the web shell (ADR 0016): overview, initiatives,
 * board, tasks, milestones and my tasks, a settings section and a home card.
 * Opt-in: shown only where the server lists the module as enabled
 * (ORBIT_WORK and the project row). Details open by query parameter
 * (?task=<id>, ?initiative=<id>), as routes have no dynamic segments.
 */
export const workWeb: WebModule = {
  id: "work",
  optIn: true,
  displayName: { en: "Project management", de: "Projektmanagement" },
  description: {
    en: "Initiatives, milestones and tasks.",
    de: "Vorhaben, Meilensteine und Aufgaben.",
  },
  home: WorkHome,
  homeOrder: 8,
  // After Marketing (10), before Support (20): Q-P1-4, 2026-10-25.
  groupOrder: 15,
  settings: workSettings,
  attention: workAttention,
  actionRequests: workActionRequests,
  views: [
    {
      key: "work",
      path: "",
      component: WorkOverview,
      nav: { label: nav("overview"), icon: LayoutDashboard, order: 0 },
    },
    {
      key: "work-initiatives",
      path: "initiatives",
      component: InitiativesView,
      nav: { label: nav("initiatives"), icon: FolderKanban, order: 10 },
    },
    {
      key: "work-board",
      path: "board",
      component: BoardView,
      nav: { label: nav("board"), icon: Columns3, order: 20, mobile: true, mobileRank: 55 },
    },
    {
      key: "work-tasks",
      path: "tasks",
      component: TaskListView,
      nav: { label: nav("tasks"), icon: ListChecks, order: 30 },
    },
    {
      key: "work-milestones",
      path: "milestones",
      component: MilestonesView,
      nav: { label: nav("milestones"), icon: CalendarCheck, order: 40 },
    },
    {
      key: "work-my",
      path: "my",
      component: MyTasksView,
      nav: { label: nav("my"), icon: UserRoundCheck, order: 50, mobile: true, mobileRank: 45 },
    },
  ],
};
