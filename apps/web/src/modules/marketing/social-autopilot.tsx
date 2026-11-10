"use client";
import { useEffect, useState } from "react";
import { ApiError, put, useResource } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { DataForm } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import type { Locale } from "@/lib/i18n";
import { marketingText } from "./labels";

// The owner's per-project switch "Autopilot through Social" (plan
// 2026-11-10), under the publishing rules. On Social, live autopilot
// publishes without per-post approval only while it is on; the server
// refuses it elsewhere and turns it off when the project leaves Social.
// Shown only for a project on Social; everyone sees the state, only an
// owner changes it.

/** The element id the AUTOPILOT_ON_SOCIAL_NOT_APPROVED texts link to. */
export const SOCIAL_AUTOPILOT_ANCHOR = "social-autopilot";

type Backend = "postiz" | "postiz_draining" | "social";
export type MarketingSettingsView = {
  settings: { publishingBackend: Backend; socialAutopilot?: boolean };
  version: number;
};

/**
 * The PUT body: the current settings with only the switch changed. The API
 * replaces the settings as a whole, so the backend is always sent along.
 */
export function socialAutopilotBody(
  current: MarketingSettingsView,
  on: boolean,
) {
  return {
    settings: { ...current.settings, socialAutopilot: on },
    version: current.version,
  };
}

export function SocialAutopilotPanel({
  view,
  owner,
  locale,
  busy,
  error,
  onTurnOn,
  onTurnOff,
}: {
  view: MarketingSettingsView | null;
  owner: boolean;
  locale: Locale;
  busy: boolean;
  error: string | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  if (view?.settings?.publishingBackend !== "social") return null;
  const words = marketingText(locale).socialAutopilot;
  const on = view.settings.socialAutopilot === true;
  const headingId = `${SOCIAL_AUTOPILOT_ANCHOR}-heading`;
  return (
    <section
      className="panel"
      id={SOCIAL_AUTOPILOT_ANCHOR}
      aria-labelledby={headingId}
    >
      <div className="panel-head">
        <div>
          <h2 id={headingId}>{words.heading}</h2>
          <p>{words.intro}</p>
        </div>
        {owner && (
          <Button
            variant={on ? "outline" : "default"}
            disabled={busy}
            onClick={on ? onTurnOff : onTurnOn}
          >
            {on ? words.turnOff : words.turnOn}
          </Button>
        )}
      </div>
      <p>
        {words.state}:{" "}
        <Badge tone={on ? "warning" : "neutral"}>
          {on ? words.on : words.off}
        </Badge>
      </p>
      <p className="panel-note">{on ? words.onNote : words.offNote}</p>
      {!owner && <p className="field-hint">{words.ownerOnly}</p>}
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}

/** Turning the switch on: what changes, what still applies, how to stop. */
export function SocialAutopilotConfirm({
  locale,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  locale: Locale;
  pending: boolean;
  error: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const words = marketingText(locale).socialAutopilot;
  return (
    <Modal title={words.confirmTitle} onClose={onCancel}>
      <Alert kind="warning">{words.confirmGoesOut}</Alert>
      <p>{words.confirmStillApplies}</p>
      <p>{words.confirmStop}</p>
      <DataForm
        fields={[
          {
            name: "confirm",
            label: words.confirmCheck,
            type: "checkbox",
            required: true,
          },
        ]}
        canSubmit={(v) => v.confirm === true}
        pending={pending}
        error={error}
        submitLabel={words.confirmSubmit}
        cancelLabel={words.cancel}
        onCancel={onCancel}
        onSubmit={(v) => (v.confirm === true ? onConfirm() : undefined)}
      />
    </Modal>
  );
}

/** The switch in Settings → Publishing rules. */
export function SocialAutopilotSection() {
  const { project, locale, isOwner } = useWorkspace();
  const path = `/projects/${encodeURIComponent(project.id)}/marketing/settings`;
  const settings = useResource<MarketingSettingsView>(path);
  // The last loaded settings, so a reload after a save does not blink.
  const [current, setCurrent] = useState<MarketingSettingsView | null>(null);
  useEffect(() => {
    if (settings.data?.settings) setCurrent(settings.data);
  }, [settings.data]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = marketingText(locale).socialAutopilot;
  if (!current) return null;
  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await put(path, socialAutopilotBody(current, on));
      setConfirming(false);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "REQUEST_FAILED";
      setError(words.errors[code] ?? code);
    } finally {
      setBusy(false);
      // Also after a version conflict: the next attempt sends the new version.
      settings.refresh();
    }
  };
  return (
    <>
      <SocialAutopilotPanel
        view={current}
        owner={isOwner}
        locale={locale}
        busy={busy}
        error={confirming ? null : error}
        onTurnOn={() => {
          setError(null);
          setConfirming(true);
        }}
        onTurnOff={() => void change(false)}
      />
      {confirming && isOwner && (
        <SocialAutopilotConfirm
          locale={locale}
          pending={busy}
          error={error}
          onConfirm={() => change(true)}
          onCancel={() => {
            setError(null);
            setConfirming(false);
          }}
        />
      )}
    </>
  );
}
