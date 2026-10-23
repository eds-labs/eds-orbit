import {
  ConnectorError,
  createMatomoClient,
  createPostizClient,
  normalizePostizBaseUrl,
} from "../../../../../../packages/connectors/src/index.ts";
import type { ConnectionsContribution } from "../../../platform/connections/connections.ts";
import { postizHealthStatus } from "./postiz-assignment.ts";

/**
 * Marketing's connection providers (WP2.5c): Postiz (publishing), Matomo
 * (analytics) and Slack (notices and approvals). The platform stores and
 * decrypts their credentials; these checks say what a connection can do.
 * Moved unchanged from the `connector-health` action.
 */
export const marketingConnections: ConnectionsContribution = {
  providers: {
    postiz: {
      // One Postiz organization can serve several projects (ADR 0013).
      scopes: ["project", "workspace", "system"],
      label: { en: "Postiz", de: "Postiz" },
      normalize: (fields) =>
        fields.baseUrl
          ? { ...fields, baseUrl: normalizePostizBaseUrl(fields.baseUrl) }
          : fields,
      async check(d, token) {
        const client = createPostizClient({ baseUrl: d.baseUrl, token });
        const channels = await client.listIntegrations();
        const checkedAt = new Date().toISOString();
        let groups: Awaited<ReturnType<typeof client.listGroups>> = [];
        try {
          groups = await client.listGroups();
        } catch (error) {
          if (!(error instanceof ConnectorError && error.status === 404))
            throw error;
        }
        const connection = {
          connected: true,
          provider: "postiz",
          baseUrl: client.baseUrl,
          channelCount: channels.length,
          checkedAt,
          error: null,
        };
        return {
          status: postizHealthStatus(d),
          capabilities: client.capabilities,
          channels,
          groups,
          baseUrl: client.baseUrl,
          connection,
          lastSuccessfulConnection: checkedAt,
        };
      },
    },
    matomo: {
      scopes: ["project", "workspace", "system"],
      label: { en: "Matomo", de: "Matomo" },
      async check(d, token) {
        const client = createMatomoClient({
          baseUrl: d.baseUrl,
          token,
          allowedSiteIds: [Number(d.siteId)],
        });
        await client.report({
          siteId: Number(d.siteId),
          method: "Goals.getGoals",
          period: "day",
          date: new Date().toISOString().slice(0, 10),
          siteTimezone: "UTC",
        });
        return { status: "read_verified", capabilities: client.capabilities };
      },
    },
    // Delivery is proven by an authorized test notice, not by a check.
    slack: { checkUnsupported: "SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION" },
  },
};
