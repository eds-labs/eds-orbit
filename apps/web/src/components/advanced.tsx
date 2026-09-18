"use client";
import { useState } from "react";
import {
  Download,
  FileText,
  Plus,
  Settings,
  UserPlus,
  Upload,
} from "lucide-react";
import {
  action,
  api,
  collectionPath,
  useMutation,
  useResource,
  value,
  type Entity,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Modal,
  Loading,
  Status,
} from "./ui/primitives";
import { DataForm, str, type FormField } from "./form";
import { useWorkspace } from "./workspace-context";
import { ResourceError, useCollection } from "./work";

type MarketingProfileView = {
  id: string;
  version: number;
  data: Record<string, any>;
};
const profileLines = (value: unknown) =>
  Array.isArray(value) ? value.join("\n") : "";
const profileCsv = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

export function MarketingProfileConfiguration() {
  const { project, isOwner, refresh } = useWorkspace();
  const facts = useCollection("facts");
  const sources = useCollection("sources");
  const assets = useCollection("assets");
  const profile = useResource<MarketingProfileView | null>(
    `/projects/${project.id}/marketing-profile`,
  );
  const mutation = useMutation(() => {
    profile.refresh();
    refresh();
  });
  const [editing, setEditing] = useState(false);
  const current = profile.data?.data;
  const factOptions = (facts.data?.items || [])
    .filter(
      (fact) =>
        fact.data.status === "verified" && fact.data.publicUse !== false,
    )
    .map((fact) => ({
      value: fact.id,
      label: `${value(fact, "key")}: ${value(fact, "value")}`,
    }));
  const link = (label: string, key: string, required = false): FormField => ({
    name: key,
    label,
    type: "select",
    required,
    value: current?.officialLinks?.find((item: any) => item.label === label)
      ?.factId,
    options: factOptions,
    hint: "Only a public, verified fact containing the exact official URL can be selected.",
  });
  const form: FormField[] = [
    {
      name: "productName",
      label: "Product",
      required: true,
      value: current?.productName || project.name,
    },
    {
      name: "audience",
      label: "Audience",
      type: "textarea",
      required: true,
      value: current?.audience,
    },
    {
      name: "positioning",
      label: "Positioning",
      type: "textarea",
      required: true,
      value: current?.positioning,
    },
    {
      name: "productStrategy",
      label: "Product marketing strategy",
      type: "textarea",
      required: true,
      value: current?.productStrategy,
    },
    {
      name: "presaleStrategy",
      label: "Presale marketing strategy",
      type: "textarea",
      required: true,
      value: current?.presaleStrategy,
    },
    {
      name: "voice",
      label: "Brand voice (one rule per line)",
      type: "textarea",
      required: true,
      value: profileLines(current?.voice),
    },
    {
      name: "guardrails",
      label: "Content guardrails (one rule per line)",
      type: "textarea",
      required: true,
      value: profileLines(current?.guardrails),
    },
    {
      name: "primaryCtas",
      label: "Approved primary CTAs (one per line)",
      type: "textarea",
      required: true,
      value: profileLines(current?.primaryCtas),
    },
    {
      name: "channelPriority",
      label: "Channel priority (one per line)",
      type: "textarea",
      required: true,
      value: profileLines(current?.channelPriority),
    },
    {
      name: "internalLanguage",
      label: "Internal work language",
      type: "select",
      value: current?.internalLanguage || "de",
      options: [
        { value: "en", label: "English" },
        { value: "de", label: "Deutsch" },
      ],
    },
    {
      name: "notificationPreference",
      label: "Notification preference",
      type: "select",
      value: current?.notificationPreference || "telegram",
      options: [
        {
          value: "telegram",
          label: "Telegram · preference only until verified",
        },
        { value: "slack", label: "Slack · preference only until verified" },
        { value: "none", label: "None" },
      ],
    },
    link("Website", "websiteFactId", true),
    link("Web app", "webAppFactId", true),
    link("Beta registration", "registrationFactId", true),
    link("Getting Started", "docsFactId", true),
    link("X", "xFactId"),
    link("Telegram announcements", "telegramAnnouncementsFactId"),
    link("Telegram community", "telegramCommunityFactId"),
    link("LinkedIn", "linkedinFactId"),
  ];
  const labels: Array<[string, string]> = [
    ["Website", "websiteFactId"],
    ["Web app", "webAppFactId"],
    ["Beta registration", "registrationFactId"],
    ["Getting Started", "docsFactId"],
    ["X", "xFactId"],
    ["Telegram announcements", "telegramAnnouncementsFactId"],
    ["Telegram community", "telegramCommunityFactId"],
    ["LinkedIn", "linkedinFactId"],
  ];
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Project configuration</h2>
          <p>
            Versioned profile, strategy, official links, brand voice and
            campaign guardrails.
          </p>
        </div>
        <Badge tone={current ? "success" : "warning"}>
          {current ? `Profile v${profile.data?.version}` : "Not configured"}
        </Badge>
      </div>
      <Alert>
        Telegram is a preference only. It is not a verified notification or
        approval integration until a connector capability test succeeds.
      </Alert>
      {current && (
        <div className="detail-grid">
          <div>
            <strong>Profile</strong>
            <p>
              {String(current.productName)} · {String(current.audience)}
            </p>
          </div>
          <div>
            <strong>Strategy</strong>
            <p>
              Separate product and presale campaigns. Owner selects target,
              window, channels, volume and sources.
            </p>
          </div>
          <div>
            <strong>Brand &amp; voice</strong>
            <p>{(current.voice || []).join(" · ")}</p>
          </div>
          <div>
            <strong>Official links</strong>
            <p>
              {(current.officialLinks || [])
                .map((item: any) => item.label)
                .join(" · ")}
            </p>
          </div>
          <div>
            <strong>Sources &amp; assets</strong>
            <p>
              {sources.data?.items.length || 0} referenced sources ·{" "}
              {
                (assets.data?.items || []).filter(
                  (asset) => asset.data.assetStatus === "approved",
                ).length
              }{" "}
              approved assets
            </p>
          </div>
          <div>
            <strong>Campaign rules</strong>
            <p>
              One campaign type and one primary CTA. Evidence and an approved
              asset are required before publication.
            </p>
          </div>
          <div>
            <strong>Automation / notifications</strong>
            <p>
              {String(current.notificationPreference)} preference only; Telegram
              is not verified.
            </p>
          </div>
        </div>
      )}
      {isOwner && (
        <Button variant="outline" onClick={() => setEditing(true)}>
          {current ? "Edit project configuration" : "Configure project"}
        </Button>
      )}
      {editing && (
        <Modal
          title="Project configuration"
          description="Saving creates a new version and sends dependent drafts and schedules back to review."
          onClose={() => setEditing(false)}
          wide
        >
          <DataForm
            fields={form}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Save configuration version"
            onCancel={() => setEditing(false)}
            onSubmit={(v) =>
              mutation
                .run(async () => {
                  const officialLinks = labels.flatMap(([label, key]) => {
                    const factId = str(v, key);
                    if (!factId) return [];
                    const fact = (facts.data?.items || []).find(
                      (item) => item.id === factId,
                    );
                    const url = String(fact?.data.value ?? "");
                    return [{ label, factId, url }];
                  });
                  return api(`/projects/${project.id}/marketing-profile`, {
                    method: "PUT",
                    body: JSON.stringify({
                      productName: str(v, "productName"),
                      contentLanguage: project.language,
                      internalLanguage: str(v, "internalLanguage"),
                      audience: str(v, "audience"),
                      positioning: str(v, "positioning"),
                      productStrategy: str(v, "productStrategy"),
                      presaleStrategy: str(v, "presaleStrategy"),
                      voice: profileCsv(str(v, "voice")),
                      guardrails: profileCsv(str(v, "guardrails")),
                      primaryCtas: profileCsv(str(v, "primaryCtas")),
                      channelPriority: profileCsv(str(v, "channelPriority")),
                      notificationPreference: str(v, "notificationPreference"),
                      officialLinks,
                      assetPolicy: "approved_only",
                    }),
                  });
                })
                .then((result) => {
                  if (result) setEditing(false);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
export function MetricCsvImport({ onClose }: { onClose: () => void }) {
  const { project, t, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const fields: FormField[] = [
    {
      name: "csv",
      label: "CSV measurements",
      type: "textarea",
      required: true,
      hint: "Paste a header row and metric records. Leave missing measures empty.",
    },
    { name: "currency", label: "Currency", required: true, placeholder: "EUR" },
    {
      name: "timezone",
      label: "Source timezone",
      value: project.timezone,
      required: true,
    },
    { name: "date", label: "Date column name", required: true },
    { name: "campaignId", label: "Campaign column name", required: true },
    ...["impressions", "clicks", "spend", "conversions"].map((name) => ({
      name,
      label: `${name} column (optional)`,
    })),
  ];
  return (
    <Modal
      title="Import CSV measurements"
      description="Columns are explicitly mapped. Missing values remain unknown, and duplicate source rows are checked server-side."
      onClose={onClose}
      wide
    >
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        t={t}
        submitLabel="Import CSV"
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() =>
              action(project.id, "import-metrics", {
                csv: str(v, "csv"),
                source: "csv",
                currency: str(v, "currency"),
                timezone: str(v, "timezone"),
                columns: {
                  date: str(v, "date"),
                  campaignId: str(v, "campaignId"),
                  ...Object.fromEntries(
                    ["impressions", "clicks", "spend", "conversions"]
                      .filter((k) => str(v, k))
                      .map((k) => [k, str(v, k)]),
                  ),
                },
              }),
            )
            .then(() => {})
        }
      />
    </Modal>
  );
}
export function ProjectAdministration() {
  const { project, isOwner, t, refresh } = useWorkspace();
  const members = useResource<{ items: Array<Record<string, unknown>> }>(
    isOwner ? collectionPath(project.id, "members") : null,
  );
  const [mode, setMode] = useState<"project" | "member" | null>(null);
  const mutation = useMutation(() => {
    refresh();
    members.refresh();
    setMode(null);
  });
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <h2>Project access</h2>
        <div className="page-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMode("project")}
          >
            <Settings data-icon="inline-start" />
            Edit project
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMode("member")}>
            <UserPlus data-icon="inline-start" />
            Add member
          </Button>
        </div>
      </div>
      <ResourceError error={members.error} retry={members.refresh} />
      {members.loading ? (
        <Loading />
      ) : members.data?.items.length ? (
        <div className="member-list">
          {members.data.items.map((m, i) => {
            const user = m.user as Record<string, unknown> | undefined;
            return (
              <div className="member-row" key={String(m.id || i)}>
                <div>
                  <strong>{String(user?.name || m.name || "Member")}</strong>
                  <small>{String(user?.email || m.email || "")}</small>
                </div>
                <Badge>{String(m.role || "member")}</Badge>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="panel-note">No additional members.</p>
      )}
      {mode && (
        <Modal
          title={mode === "project" ? "Edit project" : "Add local member"}
          description={
            mode === "member"
              ? "Creates a local identity and project membership. No email is sent. Share credentials through your own approved secure process."
              : undefined
          }
          onClose={() => setMode(null)}
        >
          <DataForm
            fields={
              mode === "project"
                ? [
                    {
                      name: "name",
                      label: t("name"),
                      value: project.name,
                      required: true,
                    },
                    {
                      name: "timezone",
                      label: t("timezone"),
                      value: project.timezone,
                      required: true,
                    },
                    {
                      name: "language",
                      label: "Content language",
                      type: "select",
                      value: project.language,
                      options: [
                        { value: "en", label: "English" },
                        { value: "de", label: "Deutsch" },
                      ],
                    },
                  ]
                : [
                    { name: "name", label: t("name"), required: true },
                    {
                      name: "email",
                      label: "Email",
                      type: "email",
                      required: true,
                    },
                    {
                      name: "password",
                      label: "Initial password",
                      type: "password",
                      required: true,
                      hint: "At least 12 characters. Not retained in browser storage.",
                    },
                    {
                      name: "role",
                      label: "Project role",
                      type: "select",
                      value: "viewer",
                      options: [
                        { value: "viewer", label: "Viewer · read only" },
                        {
                          value: "editor",
                          label: "Editor · content and review",
                        },
                        {
                          value: "owner",
                          label: "Owner · full project authority",
                        },
                      ],
                    },
                  ]
            }
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={() => setMode(null)}
            submitLabel={t("save")}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(
                    project.id,
                    mode === "project" ? "project-settings" : "add-member",
                    mode === "project"
                      ? {
                          name: str(v, "name"),
                          timezone: str(v, "timezone"),
                          language: str(v, "language"),
                        }
                      : {
                          name: str(v, "name"),
                          email: str(v, "email"),
                          password: String(v.password),
                          role: str(v, "role"),
                        },
                  ),
                )
                .then((result) => {
                  if (result && mode === "project") window.location.reload();
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
export function PreferenceActions({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const { project, isOwner, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onDone();
  });
  return isOwner ? (
    <>
      <div className="form-actions">
        <Button
          disabled={mutation.pending || entity.data.status === "confirmed"}
          onClick={() =>
            mutation.run(() =>
              action(project.id, "preference-update", {
                preferenceId: entity.id,
                version: entity.version,
                status: "confirmed",
              }),
            )
          }
        >
          Confirm preference
        </Button>
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </>
  ) : null;
}
export function CreativeRenderer({
  entity,
  onClose,
}: {
  entity: Entity;
  onClose: () => void;
}) {
  const { project, t } = useWorkspace();
  const assets = useCollection("assets");
  const mutation = useMutation();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  return (
    <Modal
      title="Creative production"
      description="Template rendering preserves the approved logo. Missing rights produce a creative brief, never a fabricated finished asset."
      onClose={() => {
        if (download) URL.revokeObjectURL(download);
        onClose();
      }}
      wide
    >
      <DataForm
        fields={[
          {
            name: "title",
            label: t("title"),
            required: true,
            value: value(entity, "title", ""),
          },
          {
            name: "subtitle",
            label: "Supporting copy",
            type: "textarea",
            required: true,
            value: value(entity, "body", "").slice(0, 220),
            max: 220,
          },
          {
            name: "format",
            label: "Format",
            type: "select",
            value: "square",
            options: [
              { value: "square", label: "Square · 1:1" },
              { value: "landscape", label: "Landscape · 1200 × 630" },
              { value: "portrait", label: "Portrait · 4:5" },
              { value: "story", label: "Story · 9:16" },
            ],
          },
          {
            name: "logoAssetId",
            label: "Approved logo asset",
            type: "select",
            options: (assets.data?.items || [])
              .filter(
                (e) =>
                  e.data.type === "original_logo" &&
                  e.data.usageApproved === true,
              )
              .map((e) => ({
                value: e.id,
                label: value(e, "name", value(e, "brandName", "Original logo")),
              })),
            hint: "Original branding and usage rights are required.",
          },
        ]}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel="Render preview"
        onSubmit={(v) =>
          mutation
            .run(() =>
              action<Record<string, unknown>>(project.id, "render", {
                title: str(v, "title"),
                subtitle: str(v, "subtitle"),
                format: str(v, "format"),
                ...(str(v, "logoAssetId")
                  ? { logoAssetId: str(v, "logoAssetId") }
                  : {}),
              }),
            )
            .then((r) => {
              if (r) {
                const data = (
                  r.data && typeof r.data === "object" ? r.data : r
                ) as Record<string, unknown>;
                setResult(data);
                if (
                  typeof data.base64 === "string" &&
                  data.mime === "image/png"
                ) {
                  if (download) URL.revokeObjectURL(download);
                  const bytes = Uint8Array.from(atob(data.base64), (c) =>
                    c.charCodeAt(0),
                  );
                  setDownload(
                    URL.createObjectURL(
                      new Blob([bytes], { type: "image/png" }),
                    ),
                  );
                }
              }
            })
        }
      />
      {result && (
        <div className="creative-result">
          <Status value={result.status || "rendered"} />
          {download ? (
            <>
              <img src={download} alt="Rendered creative preview" />
              <Button asChild variant="outline">
                <a href={download} download="orbit-creative.png">
                  <Download data-icon="inline-start" />
                  Download PNG
                </a>
              </Button>
            </>
          ) : (
            <Alert kind="warning">
              {String(
                result.reason ||
                  (result.creativeBrief as Record<string, unknown> | undefined)
                    ?.nextStep ||
                  "An approved brand asset is required before rendering.",
              )}
            </Alert>
          )}
        </div>
      )}
    </Modal>
  );
}

export function BrandApproval() {
  const { project, isOwner, refresh } = useWorkspace();
  const assets = useCollection("assets");
  const mutation = useMutation(refresh);
  const [open, setOpen] = useState(false);
  const approved = assets.data?.items.some(
    (e) => e.data.type === "original_logo" && e.data.usageApproved === true,
  );
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Brand and creative rights</h2>
          <p>The original EDS Labs mark is preserved unchanged.</p>
        </div>
        <Badge tone={approved ? "success" : "neutral"}>
          {approved ? "Rights approved" : "Approval required for creative use"}
        </Badge>
      </div>
      <div className="brand-approval">
        <img
          src="/brand/logo-layer-stack-mark.svg"
          alt="Original EDS Labs logo"
          width="60"
          height="60"
        />
        <div>
          <strong>EDS Labs · Layer Stack</strong>
          <p>
            Interface provenance verified. Project marketing use needs an
            explicit owner decision.
          </p>
        </div>
        {isOwner && !approved && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Review usage rights
          </Button>
        )}
      </div>
      {open && (
        <Modal
          title="Approve brand usage"
          description="Confirm that this project may use the original EDS Labs logo in its marketing materials. Brand rights remain separate from the software license."
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "confirmUsageRights",
                label:
                  "I hold the necessary rights and approve EDS Labs brand usage for this project.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Approve project usage"
            onCancel={() => setOpen(false)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action(project.id, "brand-approval", {
                    brandName: "EDS Labs",
                    confirmUsageRights: true,
                  }),
                )
                .then((r) => {
                  if (r) setOpen(false);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
