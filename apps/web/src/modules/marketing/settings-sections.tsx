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
import { AutopilotSettings } from "./autopilot-settings";
import { BrandApproval, MarketingProfileConfiguration } from "./advanced";
import {
  Assignments,
  AutopilotMigrationPanel,
  useAssignments,
} from "./assignments";

// Marketing's tabs of the project settings (WP2.3b), moved unchanged from
// ProjectSettings: assignments or the weekly autopilot, the versioned
// operating policy, and the brand.

const POLICY_TAB = {
  key: "policy",
  label: { en: "Policy & budget", de: "Richtlinie & Budget" },
  order: 20,
};

// Orbit Agents: once its route answered, the assignments tab replaces the
// weekly autopilot's; any error without an answer keeps the autopilot, and
// neither tab shows before that is decided (agentsSurface).
function useAgentsSection() {
  const assignments = useAssignments();
  if (assignments.surface === "assignments")
    return {
      label: { en: "Assignments", de: "Aufträge" },
      content: assignments.available ? (
        <>
          <AutopilotMigrationPanel />
          <Assignments
            resource={assignments.resource}
            data={assignments.data}
          />
        </>
      ) : null,
    };
  if (assignments.surface === "autopilot")
    return {
      label: { en: "Autopilot", de: "Autopilot" },
      content: <AutopilotSettings />,
    };
  return null;
}

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

export const marketingSettings: readonly SettingsSection[] = [
  {
    tab: {
      key: "agents",
      label: { en: "Assignments", de: "Aufträge" },
      order: 10,
    },
    order: 0,
    useSection: useAgentsSection,
  },
  { tab: POLICY_TAB, order: 0, useSection: usePolicySection },
  {
    tab: { key: "brand", label: { en: "Brand", de: "Marke" }, order: 30 },
    order: 0,
    useSection: () => ({
      content: (
        <>
          <BrandApproval />
          <MarketingProfileConfiguration />
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
