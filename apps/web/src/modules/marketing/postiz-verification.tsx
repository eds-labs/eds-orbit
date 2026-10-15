"use client";
// Postiz write verification (WP2.3b), moved unchanged from components/operator-tools.tsx.
import { useState } from "react";
import {
  action,
  useMutation,
  value,
  when,
  type Entity,
  libraryAssets,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Modal,
  Status,
} from "@/components/ui/primitives";
import { DataForm, options, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError, useCollection } from "@/platform/ui/collection";
export function PostizVerification({ connector }: { connector: Entity }) {
  const { project, isOwner, locale, refresh } = useWorkspace();
  const verifications = useCollection("connector_verifications");
  const assets = useCollection("assets");
  const [open, setOpen] = useState(false);
  const [packet, setPacket] = useState<Entity | null>(null);
  const mutation = useMutation(refresh);
  const accounts = (
    Array.isArray(connector.data.channels) ? connector.data.channels : []
  ).filter((a): a is Record<string, unknown> =>
    Boolean(
      a &&
      typeof a === "object" &&
      !(a as Record<string, unknown>).disabled &&
      Array.isArray(connector.data.assignedIntegrationIds) &&
      connector.data.assignedIntegrationIds.includes(
        (a as Record<string, unknown>).id,
      ),
    ),
  );
  const records = (verifications.data?.items || []).filter(
    (v) => v.data.connectorId === connector.id,
  );
  const approvedAssets = libraryAssets(assets.data?.items).filter(
    (a) =>
      a.data.mime === "image/png" &&
      a.data.usageApproved === true &&
      a.data.hasContent === true,
  );
  const packetAsset =
    packet?.data.asset && typeof packet.data.asset === "object"
      ? (packet.data.asset as Record<string, unknown>)
      : null;
  const previewAsset =
    packetAsset &&
    approvedAssets.find(
      (a) => a.id === packetAsset.assetId && a.version === packetAsset.version,
    );
  if (!isOwner) return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          setPacket(null);
          mutation.clear();
        }}
      >
        Verify sandbox write
      </Button>
      {open && (
        <Modal
          title="Postiz sandbox verification"
          description="A read check does not establish publishing capability. Prepare a concrete package, review the account and exact test content, then explicitly authorize one test write."
          onClose={() => setOpen(false)}
        >
          <ResourceError
            error={verifications.error}
            retry={verifications.refresh}
          />
          {!packet ? (
            <>
              {!["read_verified", "write_verified"].includes(
                String(connector.data.status),
              ) || !accounts.length ? (
                <Alert kind="warning">
                  Run a successful read capability check first. Only enabled
                  accounts returned by that check can be selected.
                </Alert>
              ) : (
                <DataForm
                  fields={[
                    {
                      name: "integrationId",
                      label: "Sandbox social account",
                      type: "select",
                      required: true,
                      options: accounts.map((a) => ({
                        value: String(a.id),
                        label: `${String(a.name || a.id)} · ${String(a.identifier || "")}`,
                      })),
                    },
                    {
                      name: "assetId",
                      label: "Approved PNG test asset (optional)",
                      type: "select",
                      options: approvedAssets.map((a) => ({
                        value: a.id,
                        label: `${value(a, "title", "Rendered asset")} · version ${a.version}`,
                      })),
                      hint: "A successful image proof is recorded separately from plain text publishing.",
                    },
                    {
                      name: "confirm",
                      label:
                        "This account is a sandbox account authorized for this connection test",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Prepare exact test package"
                  onSubmit={(v) =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "postiz-test-prepare", {
                          connectorId: connector.id,
                          integrationId: str(v, "integrationId"),
                          confirmSandboxAccount: true,
                          ...(str(v, "assetId")
                            ? { assetId: str(v, "assetId") }
                            : {}),
                        }),
                      )
                      .then((r) => {
                        if (r) setPacket(r);
                      })
                  }
                />
              )}
              {records.length > 0 && (
                <section>
                  <h3>Verification history</h3>
                  {records.map((v) => (
                    <div className="data-row" key={v.id}>
                      <div>
                        <strong>{value(v, "integrationName")}</strong>
                        <Status value={v.data.status} />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPacket(v);
                          mutation.clear();
                        }}
                      >
                        Inspect package
                      </Button>
                    </div>
                  ))}
                </section>
              )}
            </>
          ) : (
            <>
              <div className="detail-summary">
                <Status value={packet.data.status} />
                <Badge>
                  Connection version {value(packet, "connectorVersion")}
                </Badge>
              </div>
              <dl className="detail-grid">
                <dt>Instance</dt>
                <dd>
                  {value(packet, "baseUrl")} / {value(packet, "instanceId")}
                </dd>
                <dt>Account</dt>
                <dd>
                  {value(packet, "integrationName")} (
                  {value(packet, "integrationId")})
                </dd>
                <dt>Publication</dt>
                <dd>Immediately, after explicit approval</dd>
                <dt>Approval expires</dt>
                <dd>{when(packet.data.expiresAt, locale, project.timezone)}</dd>
                <dt>Package hash</dt>
                <dd className="break-anywhere">
                  {value(packet, "packageHash")}
                </dd>
              </dl>
              {packetAsset && (
                <section>
                  <h3>Exact test image</h3>
                  <p>
                    {String(packetAsset.width)} × {String(packetAsset.height)} ·{" "}
                    {String(packetAsset.mime)}
                  </p>
                  <p className="break-anywhere">
                    SHA-256: {String(packetAsset.hash)}
                  </p>
                  {previewAsset ? (
                    <img
                      className="creative-preview"
                      src={`/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(previewAsset.id)}/content`}
                      alt="Prepared sandbox verification asset"
                    />
                  ) : (
                    <Alert kind="warning">
                      The exact approved image version is unavailable. Refresh
                      and prepare a current package before authorizing
                      publication.
                    </Alert>
                  )}
                </section>
              )}
              <h3>Exact test text</h3>
              <blockquote className="evidence-excerpt">
                {value(packet, "body")}
              </blockquote>
              <Alert kind="warning">
                {value(packet, "cleanup")} Live mode and external-write
                configuration must also permit this action.
              </Alert>
              {packet.data.status === "prepared" &&
              (!packetAsset || previewAsset) ? (
                <DataForm
                  key={packet.id}
                  fields={[
                    {
                      name: "confirm",
                      label:
                        "Publish this exact text and any displayed image to the sandbox account now",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Publish the approved test once"
                  onSubmit={() =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "postiz-test-execute", {
                          verificationId: packet.id,
                          packageHash: packet.data.packageHash,
                          confirmPublishExactTest: true,
                        }),
                      )
                      .then((r) => {
                        if (r) setPacket(r);
                      })
                  }
                />
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={mutation.pending}
                    onClick={() =>
                      mutation
                        .run(() =>
                          action<Entity>(project.id, "postiz-test-reconcile", {
                            verificationId: packet.id,
                          }),
                        )
                        .then((r) => {
                          if (r) setPacket(r);
                        })
                    }
                  >
                    Read remote test outcome
                  </Button>
                  {mutation.error && (
                    <Alert kind="error">{mutation.error}</Alert>
                  )}
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
