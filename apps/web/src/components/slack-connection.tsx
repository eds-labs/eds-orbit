"use client";
import { useState } from "react";
import { action, useMutation, type Entity } from "@/lib/api";
import { useWorkspace } from "./workspace-context";
import { Alert, Button, Modal } from "./ui/primitives";
import { DataForm, dateField, iso, str } from "./form";
export function SlackConfiguration({ onClose }: { onClose: () => void }) {
  const { project, identity, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  return (
    <Modal
      title="Configure Slack decisions"
      description="Store one channel mandate and its owner mapping. This form sends no Slack message. Credentials are encrypted on your server and never displayed again."
      onClose={onClose}
    >
      <Alert>
        In your Slack app, set the interaction URL to your public Orbit origin
        followed by{" "}
        <code>{`/api/slack/${project.workspaceId}/${project.id}/interactions`}</code>
        . Delivery and inbound reachability remain unverified until an
        authorized end-to-end test succeeds.
      </Alert>
      <DataForm
        fields={[
          {
            name: "botToken",
            label: "Bot token",
            type: "password",
            required: true,
          },
          {
            name: "signingSecret",
            label: "Signing secret",
            type: "password",
            required: true,
            min: 32,
          },
          {
            name: "teamId",
            label: "Slack workspace ID",
            required: true,
            placeholder: "T…",
          },
          {
            name: "channelId",
            label: "Authorized channel ID",
            required: true,
            placeholder: "C…",
          },
          {
            name: "slackUserId",
            label: "Your Slack user ID",
            required: true,
            placeholder: "U…",
            hint: `Maps only to your signed-in Orbit owner account (${identity.user.name}).`,
          },
          dateField(
            "validUntil",
            "Channel mandate expires (browser time, within 90 days)",
          ),
          {
            name: "allowApprovals",
            label:
              "Allow this mapped owner to approve exact reviewed social packages from Slack",
            type: "checkbox",
          },
          {
            name: "confirmChannelMandate",
            label:
              "I authorize exception notifications and signed owner actions in this exact workspace and channel until the selected expiry.",
            type: "checkbox",
            required: true,
          },
        ]}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel="Save channel mandate"
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() =>
              action(project.id, "slack-configure", {
                botToken: str(v, "botToken"),
                signingSecret: str(v, "signingSecret"),
                teamId: str(v, "teamId"),
                channelId: str(v, "channelId"),
                validUntil: iso(v, "validUntil"),
                allowApprovals: v.allowApprovals === true,
                confirmChannelMandate: true,
                actors: [
                  {
                    slackUserId: str(v, "slackUserId"),
                    orbitUserId: identity.user.id,
                  },
                ],
              }),
            )
            .then(() => {})
        }
      />
    </Modal>
  );
}
export function SlackDigest({ entity }: { entity: Entity }) {
  const { project, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const mutation = useMutation(refresh);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Review notification request
      </Button>
      {open && (
        <Modal
          title="Request Slack digest"
          description={`Destination: workspace ${String(entity.data.teamId)}, channel ${String(entity.data.channelId)}. The worker checks the active mandate and external-write gate before sending.`}
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "confirm",
                type: "checkbox",
                required: true,
                label:
                  "Request delivery of current exception codes and eligible approval packages to this authorized channel.",
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Queue authorized digest"
            onCancel={() => setOpen(false)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action<Record<string, unknown>>(
                    project.id,
                    "slack-digest",
                    {},
                  ),
                )
                .then((r) => {
                  if (r) setResult(r);
                })
            }
          />
          {result && (
            <Alert kind="success">
              {result.unchanged
                ? "No new actionable notification was queued."
                : "Notification intent recorded. Delivery status is shown in Operations; queuing alone does not prove delivery."}
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}
