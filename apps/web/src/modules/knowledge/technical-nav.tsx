"use client";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { expertCopy } from "./expert-text";
import type { KnowledgeTab } from "./knowledge";

/** The bar above the expert pages while the Knowledge workspace is on. */
export function TechnicalNav({ tab }: { tab: KnowledgeTab }) {
  const { locale, isOwner } = useWorkspace();
  const shell = useShell();
  const x = expertCopy[locale];
  const entries: Array<{
    key: KnowledgeTab;
    label: string;
    expert: boolean;
  }> = [
    { key: "sources", label: x.navSources, expert: true },
    { key: "facts", label: x.navFacts, expert: true },
    { key: "conflicts", label: x.navConflicts, expert: true },
    { key: "import", label: x.navImport, expert: true },
    { key: "library", label: x.navLibrary, expert: true },
    { key: "health", label: x.navHealth, expert: true },
    { key: "inspector", label: x.navInspector, expert: true },
    { key: "impact", label: x.navImpact, expert: true },
    ...(isOwner
      ? [{ key: "github" as const, label: x.navGithub, expert: false }]
      : []),
  ];
  return (
    <nav className="technical-nav" aria-label={x.navLabel}>
      {entries.map(({ key, label, expert }) => (
        <AppLink
          key={key}
          className="text-link"
          href={shell.hrefOf(`knowledge-${key}`) + (expert ? "?expert=1" : "")}
          aria-current={tab === key ? "page" : undefined}
        >
          {label}
        </AppLink>
      ))}
      <AppLink className="text-link" href={shell.hrefOf("knowledge")}>
        {x.navBack}
      </AppLink>
    </nav>
  );
}
