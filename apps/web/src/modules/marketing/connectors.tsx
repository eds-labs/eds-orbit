"use client";
import { FileText, Wallet } from "lucide-react";
import type { Entity } from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PostizVerification } from "./postiz-verification";
import { AppLink } from "@/platform/ui/app-link";
import type { ConnectorProvider } from "@/platform/shell/types";
import { PostizChannelAssignment } from "./postiz-channels";
import { SlackConfiguration, SlackDigest } from "./slack-connection";

// Marketing's connections on the connectors page (WP2.3b), moved unchanged
// from Connectors in components/management.tsx: Postiz, Matomo and Slack
// with their details and actions, and the blog and newsletter cards.

function PostizDetails({ connector: e }: { connector: Record<string, any> }) {
  const { project } = useWorkspace();
  return (
    <div className="connector-details">
      <p>
        <strong>API:</strong> {String(e.data.baseUrl || "Not configured")}
      </p>
      <p>
        <strong>Secret:</strong> Configured via server storage
      </p>
      {Array.isArray(e.data.groups) && e.data.groups.length > 0 && (
        <p>
          <strong>Groups:</strong>{" "}
          {e.data.groups
            .map((group: any) => String(group.name || group.id))
            .join(", ")}
        </p>
      )}
      {Array.isArray(e.data.channels) && e.data.channels.length > 0 ? (
        <ul aria-label="Connected Postiz channels">
          {e.data.channels.map((channel: any) => (
            <li key={String(channel.id)}>
              <strong>{String(channel.name || channel.id)}</strong> ·{" "}
              {String(channel.identifier || "unknown")} ·{" "}
              {channel.disabled
                ? "Disconnected"
                : Array.isArray(e.data.assignedIntegrationIds) &&
                    e.data.assignedIntegrationIds.includes(channel.id)
                  ? `Assigned to ${project.name}`
                  : "Not assigned"}{" "}
              <small>({String(channel.id)})</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No connected channels loaded.</p>
      )}
    </div>
  );
}

function PostizActions({ connector: e }: { connector: Record<string, any> }) {
  return (
    <>
      <PostizChannelAssignment
        key={`${e.id}:${e.version}`}
        connector={e as Entity}
      />
      <PostizVerification connector={e as Entity} />
    </>
  );
}

function SlackActions({ connector: e }: { connector: Record<string, any> }) {
  return e.data.confirmChannelMandate === true ? (
    <SlackDigest entity={e as Entity} />
  ) : null;
}

export const marketingConnectorProviders: readonly ConnectorProvider[] = [
  {
    id: "postiz",
    name: "Postiz",
    description: "Social scheduling and publication reconciliation",
    capability: "Publish / reconcile",
    Details: PostizDetails,
    Actions: PostizActions,
    checkLabel: "Test connection / refresh channels",
  },
  {
    id: "matomo",
    name: "Matomo",
    description: "Website sessions and target actions",
    capability: "Read analytics",
    checkLabel: "Check capabilities",
    fields: [{ name: "siteId", label: "Matomo site ID", required: true }],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Exceptions and accountable decisions",
    capability: "Notify / receive actions",
    note: "Configuration alone does not prove delivery or signed inbound actions.",
    Actions: SlackActions,
    checkLabel: null,
    Configure: SlackConfiguration,
  },
];

function BlogExportCard() {
  return (
    <section className="connector">
      <div className="connector-mark">
        <FileText />
      </div>
      <div className="connector-body">
        <h2>Blog / file export</h2>
        <p>Reviewable Markdown packages for your website repository.</p>
        <div className="detail-summary">
          <Badge tone="blue">draft ready</Badge>
          <span>Export only · deployment requires separate authorization</span>
        </div>
      </div>
      <Button asChild variant="outline">
        <AppLink href="/content">Open content</AppLink>
      </Button>
    </section>
  );
}

function NewsletterAdsCard() {
  return (
    <section className="connector">
      <div className="connector-mark">
        <Wallet />
      </div>
      <div className="connector-body">
        <h2>Newsletter & ads</h2>
        <p>Drafts, variants and measurement imports are available.</p>
        <div className="detail-summary">
          <Badge>not configured</Badge>
          <span>
            Live delivery and ad activation require a verified provider.
          </span>
        </div>
      </div>
      <Button asChild variant="outline">
        <AppLink href="/content">Open drafts</AppLink>
      </Button>
    </section>
  );
}

export const marketingConnectorExtras = [BlogExportCard, NewsletterAdsCard];
