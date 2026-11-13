"use client";
import { AccountView } from "@/platform/account/account-view";
import { PersonalContextView } from "@/platform/account/personal-context";
import type { ManagementSection, SectionProps } from "../types";
import { GrantsPanel } from "./grants-panel";

// The account scope mounts the account and assistant-context views (the old
// /account addresses redirect here). Both read the standalone context the
// shell provides around the scope.

function ProfileSection() {
  return <AccountView />;
}

function AppsSection({ scope }: SectionProps) {
  return <GrantsPanel scope={scope} showUser={false} />;
}

function ContextSection() {
  return <PersonalContextView />;
}

export const accountSections: readonly ManagementSection[] = [
  {
    id: "account",
    scope: "account",
    area: "profile",
    order: 0,
    capability: "account.profile",
    ownHead: true,
    label: { en: "Your account", de: "Dein Konto" },
    description: {
      en: "Profile, e-mail address, password and sessions.",
      de: "Profil, E-Mail-Adresse, Passwort und Sitzungen.",
    },
    component: ProfileSection,
  },
  {
    id: "apps",
    scope: "account",
    area: "connections",
    order: 0,
    capability: "account.apps",
    label: { en: "Connected apps", de: "Verbundene Apps" },
    description: {
      en: "Apps you allowed to use Orbit on your behalf; you can revoke each one.",
      de: "Apps, die du für Orbit freigegeben hast; du kannst jede widerrufen.",
    },
    component: AppsSection,
  },
  {
    id: "context",
    scope: "account",
    area: "assistant",
    order: 0,
    capability: "account.assistant",
    ownHead: true,
    label: { en: "My context", de: "Mein Kontext" },
    description: {
      en: "What your personal assistant remembers; only you can see it.",
      de: "Was sich dein persönlicher Assistent merkt; nur du siehst es.",
    },
    component: ContextSection,
  },
];
