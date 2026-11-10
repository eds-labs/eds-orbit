"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, ShieldCheck } from "lucide-react";
import { Button, Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError, useCollection } from "@/platform/ui/collection";
import type { SettingsSection } from "@/platform/shell/types";
import { PolicyEditor } from "./policy-editor";
import { PolicyVersions } from "./policy-versions";
import { marketingText } from "./labels";
import { BrandApproval, MarketingProfileConfiguration } from "./advanced";
import { BrandKitSection } from "./creative/brand-kit-section";

// Marketing's sections of the project settings (WP2.3b): the versioned
// operating policy and the brand. The assignments are a Marketing page
// since 2026-10-19 (they are operations, not configuration).

const POLICY_TAB = {
  key: "policy",
  label: { en: "Publishing rules", de: "Veröffentlichungsregeln" },
  order: 20,
};

function usePolicySection() {
  const { locale, isOwner } = useWorkspace();
  const words = marketingText(locale).policy;
  const policies = useCollection("policies");
  const [policy, setPolicy] = useState(false);
  return {
    notice: <ResourceError error={policies.error} retry={policies.refresh} />,
    content: (
      <>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{words.heading}</h2>
              <p>{words.intro}</p>
            </div>
            {isOwner && (
              <Button onClick={() => setPolicy(true)}>
                <Plus data-icon="inline-start" />
                {words.newVersion}
              </Button>
            )}
          </div>
          {policies.data?.items.length ? (
            <PolicyVersions items={policies.data.items} />
          ) : (
            <Empty
              icon={ShieldCheck}
              title={words.emptyTitle}
              description={words.emptyText}
            />
          )}
        </section>
        {policy && <PolicyEditor onClose={() => setPolicy(false)} />}
      </>
    ),
  };
}

// In the Marketing group of the settings (UI restructure §5.4): policy &
// budget first, which is always shown and so the sidebar's settings link,
// then brand.
export const marketingSettings: readonly SettingsSection[] = [
  { tab: POLICY_TAB, order: 0, useSection: usePolicySection },
  {
    tab: { key: "brand", label: { en: "Brand", de: "Marke" }, order: 30 },
    order: 0,
    useSection: () => ({
      content: (
        <>
          <BrandApproval />
          <MarketingProfileConfiguration />
          {/* Renders nothing while the Creative Studio is off. */}
          <BrandKitSection />
        </>
      ),
    }),
  },
];

/**
 * The settings overview's link to the policy editor (WP2.3b). The policy
 * holds the publishing rules; the AI budget is under Settings → AI & budget.
 */
export function PolicySetupLink() {
  const { isOwner, locale } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={!isOwner}>
        <ShieldCheck />
        {marketingText(locale).policy.setupLink}
      </button>
      {/* Outside .setup-links, whose button and icon styles would apply. */}
      {open &&
        createPortal(
          <PolicyEditor onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}
