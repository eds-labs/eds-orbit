"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, ShieldCheck, Wallet } from "lucide-react";
import type { Entity } from "@/lib/api";
import { Button, Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import {
  EntityRows,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { RecordDetail } from "@/platform/ui/record-detail";
import type { SettingsSection } from "@/platform/shell/types";
import { PolicyEditor } from "./policy-editor";
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
  const policies = useCollection("policies");
  const [policy, setPolicy] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  return {
    notice: <ResourceError error={policies.error} retry={policies.refresh} />,
    content: (
      <>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>
                {locale === "de"
                  ? "Versionierte Betriebsrichtlinie"
                  : "Versioned operating policy"}
              </h2>
              <p>
                {locale === "de"
                  ? "Ein Mandat ist konkret, zeitlich begrenzt und überprüfbar."
                  : "A mandate is specific, time-bounded and verifiable."}
              </p>
            </div>
            {isOwner && (
              <Button onClick={() => setPolicy(true)}>
                <Plus data-icon="inline-start" />
                New policy version
              </Button>
            )}
          </div>
          {policies.data?.items.length ? (
            <EntityRows
              items={policies.data.items}
              fields={["mode", "status", "createdAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={ShieldCheck}
              title="Observe is the safe starting point"
              description="No publishing mandate or paid model budget has been configured."
            />
          )}
        </section>
        {policy && <PolicyEditor onClose={() => setPolicy(false)} />}
        {selected && (
          <RecordDetail entity={selected} onClose={() => setSelected(null)} />
        )}
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

/** The project overview's link to the policy editor (WP2.3b). */
export function PolicySetupLink() {
  const { isOwner } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={!isOwner}>
        <Wallet />
        Set budget and routine boundaries
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
