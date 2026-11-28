import {
  Activity,
  BookOpen,
  BrainCircuit,
  Building2,
  Cable,
  ChartNoAxesCombined,
  Database,
  Inbox,
  Kanban,
  LayoutGrid,
  LifeBuoy,
  Link2,
  ListChecks,
  Megaphone,
  Newspaper,
  Plug,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

const moduleIcons: Readonly<Record<string, LucideIcon>> = {
  marketing: Megaphone,
  cms: Newspaper,
  social: Share2,
  ads: Target,
  seo: ChartNoAxesCombined,
  work: Kanban,
  support: LifeBuoy,
  webmail: Inbox,
  knowledge: BookOpen,
  issues: ListChecks,
  finance: Wallet,
};

const settingsIcons: Readonly<Record<string, LucideIcon>> = {
  overview: Activity,
  users: Users,
  organizations: Building2,
  integrations: Plug,
  ai: BrainCircuit,
  mcp: Cable,
  security: ShieldCheck,
  members: Users,
  policies: ShieldCheck,
  profile: UserRound,
  modules: LayoutGrid,
  data: Database,
  connections: Link2,
  assistant: Sparkles,
};

export function workspaceGroupIcon(id: string, fallback: LucideIcon): LucideIcon {
  return id === "project" ? Settings : moduleIcons[id] ?? fallback;
}

export function settingsGroupIcon(id: string): LucideIcon {
  return moduleIcons[id] ?? settingsIcons[id] ?? Settings;
}
