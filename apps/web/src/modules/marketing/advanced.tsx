"use client";
import { useEffect, useState } from "react";
import { Download, Image as ImageIcon, Sparkles, Upload } from "lucide-react";
import {
  action,
  api,
  collectionPath,
  useMutation,
  useResource,
  value,
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
import { DataForm, str, type FormField } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { useCollection } from "@/platform/ui/collection";
import {
  brandTermsField,
  officialLinkCandidates,
  profileCampaignTypes,
} from "./profile-fields";
import {
  AGENT_CONTENT_LANGUAGES,
  languageName,
  projectLinksOf,
} from "@/platform/project-settings/catalog";
import { languagesOf } from "@/platform/project-settings/project-configuration";

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
async function fileBase64(file: File) {
  if (!file.size || file.size > 1_000_000)
    throw new Error("ASSET_UPLOAD_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

// The Marketing profile's wording (de/en); missing German falls back to English.
const PROFILE_TEXT = {
  heading: { en: "Marketing profile", de: "Marketing-Profil" },
  intro: {
    en: "Versioned positioning, strategy, brand voice, official target links and campaign guardrails of the Marketing module. Project-wide languages and profile links are under Settings → Project.",
    de: "Versionierte Positionierung, Strategie, Markenstimme, offizielle Ziel-Links und Kampagnenregeln des Marketing-Moduls. Projektweite Sprachen und Profil-Links stehen unter Einstellungen → Projekt.",
  },
  notConfigured: { en: "Not configured", de: "Nicht eingerichtet" },
  version: { en: "Profile v", de: "Profil v" },
  telegramNote: {
    en: "Telegram is a preference only. It is not a verified notification or approval integration until a connector capability test succeeds.",
    de: "Telegram ist nur eine Präferenz. Es ist keine verifizierte Benachrichtigungs- oder Freigabe-Integration, bis ein Fähigkeitstest der Verbindung erfolgreich war.",
  },
  summaryProfile: { en: "Profile", de: "Profil" },
  summaryStrategy: { en: "Strategy", de: "Strategie" },
  summaryStrategyText: {
    en: "Separate product and presale campaigns. Owner selects target, window, channels, volume and sources.",
    de: "Getrennte Produkt- und Presale-Kampagnen. Der Owner wählt Ziel, Zeitraum, Kanäle, Umfang und Quellen.",
  },
  summaryBrand: { en: "Brand & voice", de: "Marke & Stimme" },
  summaryLinks: { en: "Official target links", de: "Offizielle Ziel-Links" },
  summaryLanguage: {
    en: "Agent content language",
    de: "Content-Sprache der Agenten",
  },
  summarySources: { en: "Sources & assets", de: "Quellen & Assets" },
  sourcesAssets: {
    en: "{sources} referenced sources · {assets} approved assets",
    de: "{sources} referenzierte Quellen · {assets} freigegebene Assets",
  },
  summaryRules: { en: "Campaign rules", de: "Kampagnenregeln" },
  summaryRulesText: {
    en: "One campaign type and one primary CTA. Evidence and an approved asset are required before publication.",
    de: "Ein Kampagnentyp und ein primärer CTA. Vor der Veröffentlichung sind Belege und ein freigegebenes Asset nötig.",
  },
  summaryNotifications: {
    en: "Automation / notifications",
    de: "Automatisierung / Benachrichtigungen",
  },
  preferenceOnly: {
    en: "{value} preference only; Telegram is not verified.",
    de: "{value} nur als Präferenz; Telegram ist nicht verifiziert.",
  },
  edit: { en: "Edit marketing profile", de: "Marketing-Profil bearbeiten" },
  configure: {
    en: "Set up marketing profile",
    de: "Marketing-Profil einrichten",
  },
  modalDescription: {
    en: "Saving creates a new version and sends dependent drafts and schedules back to review.",
    de: "Speichern erzeugt eine neue Version und schickt abhängige Entwürfe und Planungen zurück in die Prüfung.",
  },
  submit: { en: "Save profile version", de: "Profilversion speichern" },
  product: { en: "Product", de: "Produkt" },
  audience: { en: "Audience", de: "Zielgruppe" },
  positioning: { en: "Positioning", de: "Positionierung" },
  productStrategy: {
    en: "Product marketing strategy",
    de: "Produkt-Marketingstrategie",
  },
  presaleStrategy: {
    en: "Presale marketing strategy",
    de: "Presale-Marketingstrategie",
  },
  campaignTypes: { en: "Campaign types", de: "Kampagnentypen" },
  campaignTypesHint: {
    en: "Only the strategies of the chosen campaign types are needed. A hidden strategy stays saved.",
    de: "Nur die Strategien der gewählten Kampagnentypen werden benötigt. Eine ausgeblendete Strategie bleibt gespeichert.",
  },
  campaignProduct: { en: "Product campaigns", de: "Produktkampagnen" },
  campaignPresale: { en: "Presale campaigns", de: "Presale-Kampagnen" },
  campaignBoth: {
    en: "Product and presale campaigns",
    de: "Produkt- und Presale-Kampagnen",
  },
  versionConflict: {
    en: "The profile changed meanwhile, for example through an approved MCP change. Close the editor and open it again to edit the current version.",
    de: "Das Profil wurde inzwischen geändert, etwa durch eine freigegebene MCP-Änderung. Schließe den Editor und öffne ihn erneut, um die aktuelle Version zu bearbeiten.",
  },
  voice: {
    en: "Brand voice (one rule per line)",
    de: "Markenstimme (eine Regel pro Zeile)",
  },
  primaryColor: { en: "Primary brand color", de: "Primäre Markenfarbe" },
  secondaryColor: { en: "Secondary brand color", de: "Sekundäre Markenfarbe" },
  accentColor: { en: "Accent color", de: "Akzentfarbe" },
  backgroundColor: { en: "Background color", de: "Hintergrundfarbe" },
  surfaceColor: { en: "Surface color", de: "Flächenfarbe" },
  textColor: { en: "Text color", de: "Textfarbe" },
  headingFont: { en: "Heading font preset", de: "Schrift für Überschriften" },
  bodyFont: { en: "Body font preset", de: "Schrift für Fließtext" },
  logo: { en: "Default approved logo", de: "Freigegebenes Standardlogo" },
  logoHint: {
    en: "Upload and approve additional logo variants in the asset library.",
    de: "Weitere Logovarianten in der Asset-Bibliothek hochladen und freigeben.",
  },
  approvedLogo: { en: "Approved logo", de: "Freigegebenes Logo" },
  designRules: {
    en: "Visual brand rules (one per line)",
    de: "Visuelle Markenregeln (eine pro Zeile)",
  },
  designRulesHint: {
    en: "Only rules confirmed by the brand owner belong here.",
    de: "Hier gehören nur Regeln hin, die die Markenverantwortlichen bestätigt haben.",
  },
  guardrails: {
    en: "Content guardrails (one rule per line)",
    de: "Inhaltliche Leitplanken (eine Regel pro Zeile)",
  },
  primaryCtas: {
    en: "Approved primary CTAs (one per line)",
    de: "Freigegebene primäre CTAs (einer pro Zeile)",
  },
  brandTerms: {
    en: "Product words in fact sentences (one per line)",
    de: "Produktwörter in Faktensätzen (eines pro Zeile)",
  },
  brandTermsHint: {
    en: "Lower-case words of the product name that a fact sentence may contain, such as the brand. Empty keeps the built-in default words. Saving the profile invalidates pending packages.",
    de: "Kleingeschriebene Wörter des Produktnamens, die ein Faktensatz enthalten darf, etwa die Marke. Leer behält die eingebauten Standardwörter. Speichern macht offene Pakete ungültig.",
  },
  channelPriority: {
    en: "Channel priority (one per line)",
    de: "Kanalpriorität (einer pro Zeile)",
  },
  contentLanguage: {
    en: "Content language of automatic agents",
    de: "Content-Sprache automatischer Agenten",
  },
  contentLanguageHint: {
    en: "Assignments and agent drafts are written in this language (English or German). Manual campaigns may use every project content language.",
    de: "Aufträge und Agenten-Entwürfe werden in dieser Sprache geschrieben (Englisch oder Deutsch). Manuelle Kampagnen können jede Content-Sprache des Projekts nutzen.",
  },
  languageNotInProject: {
    en: "The profile's agent language ({code}) is not one of the project's content languages. Assignments keep writing in it; add it under Settings → Project or choose another one here.",
    de: "Die Agentensprache des Profils ({code}) gehört nicht zu den Content-Sprachen des Projekts. Aufträge schreiben weiter darin; füge sie unter Einstellungen → Projekt hinzu oder wähle hier eine andere.",
  },
  internalLanguage: {
    en: "Internal work language",
    de: "Interne Arbeitssprache",
  },
  notificationPreference: {
    en: "Notification preference",
    de: "Benachrichtigungspräferenz",
  },
  telegramPreference: {
    en: "Telegram · preference only until verified",
    de: "Telegram · nur Präferenz bis zur Verifizierung",
  },
  slackPreference: {
    en: "Slack · preference only until verified",
    de: "Slack · nur Präferenz bis zur Verifizierung",
  },
  none: { en: "None", de: "Keine" },
  officialLinksHeading: {
    en: "Official target links (at least one)",
    de: "Offizielle Ziel-Links (mindestens einer)",
  },
  officialLinkHint: {
    en: "Posts may link only to these addresses. Each is backed by a public, verified fact with the exact address.",
    de: "Posts dürfen nur auf diese Adressen verlinken. Jede ist durch einen öffentlichen, verifizierten Fakt mit genau dieser Adresse belegt.",
  },
  noCandidates: {
    en: "No project profile link has a public, verified fact with its exact address yet. Add links under Settings → Project and verify them as facts in Knowledge.",
    de: "Noch kein Profil-Link des Projekts hat einen öffentlichen, verifizierten Fakt mit genau seiner Adresse. Füge Links unter Einstellungen → Projekt hinzu und verifiziere sie als Fakten im Wissen.",
  },
  unverifiedLinks: {
    en: "Not selectable until a public, verified fact states their exact address: {links}",
    de: "Nicht wählbar, bis ein öffentlicher, verifizierter Fakt genau ihre Adresse nennt: {links}",
  },
  oneLinkRequired: {
    en: "Choose at least one official target link.",
    de: "Wähle mindestens einen offiziellen Ziel-Link.",
  },
} satisfies Record<string, { en: string; de: string }>;
type ProfileTextKey = keyof typeof PROFILE_TEXT;
function profileText(locale: string) {
  return (key: ProfileTextKey, vars: Record<string, string | number> = {}) => {
    const entry: { en: string; de?: string } = PROFILE_TEXT[key];
    const template = (locale === "de" && entry.de) || entry.en;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(vars[name] ?? `{${name}}`),
    );
  };
}

const optionalText = (key: string, value: unknown) =>
  typeof value === "string" && value.trim() ? { [key]: value } : {};

export function MarketingProfileConfiguration() {
  const { project, isOwner, refresh, locale } = useWorkspace();
  const p = profileText(locale);
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
  const [linkError, setLinkError] = useState(false);
  // Changes approved elsewhere (an MCP proposal) show on returning here.
  const refreshProfile = profile.refresh;
  useEffect(() => {
    window.addEventListener("focus", refreshProfile);
    return () => window.removeEventListener("focus", refreshProfile);
  }, [refreshProfile]);
  const current = profile.data?.data;
  const visual = current?.visualIdentity || {};
  const projectLanguages = languagesOf(project);
  const agentLanguages = AGENT_CONTENT_LANGUAGES.filter(
    (code) =>
      projectLanguages.includes(code) || current?.contentLanguage === code,
  );
  const agentLanguage: string =
    current?.contentLanguage ||
    (agentLanguages as readonly string[]).find((c) => c === project.language) ||
    agentLanguages[0] ||
    "en";
  const languageMissing =
    Boolean(current?.contentLanguage) &&
    !projectLanguages.includes(String(current?.contentLanguage));
  const { candidates, unverified } = officialLinkCandidates(
    projectLinksOf(project.links),
    Array.isArray(current?.officialLinks) ? current.officialLinks : [],
    facts.data?.items || [],
  );
  const logoOptions = libraryAssets(assets.data?.items)
    .filter(
      (asset) =>
        ["logo", "original_logo"].includes(String(asset.data.type)) &&
        asset.data.assetStatus === "approved" &&
        asset.data.usageApproved === true,
    )
    .map((asset) => ({
      value: asset.id,
      label: value(asset, "name", value(asset, "brandName", p("approvedLogo"))),
    }));
  const color = (name: string, fallback: string): FormField => ({
    name,
    label: p(name as ProfileTextKey),
    required: true,
    value: visual[name] || fallback,
    placeholder: fallback,
  });
  // Which campaign types the profile runs (profile-fields.ts).
  const campaignTypes = profileCampaignTypes(current);
  const campaignChoice = [...campaignTypes].sort().join(",");
  const fonts = ["Inter", "DejaVu Sans", "Arial", "system-ui"].map((font) => ({
    value: font,
    label: font,
  }));
  const form: FormField[] = [
    {
      name: "productName",
      label: p("product"),
      required: true,
      value: current?.productName || project.name,
    },
    {
      name: "audience",
      label: p("audience"),
      type: "textarea",
      required: true,
      value: current?.audience,
    },
    {
      name: "positioning",
      label: p("positioning"),
      type: "textarea",
      required: true,
      value: current?.positioning,
    },
    {
      name: "campaignTypes",
      label: p("campaignTypes"),
      type: "select",
      value: campaignChoice,
      options: [
        { value: "product", label: p("campaignProduct") },
        { value: "presale,product", label: p("campaignBoth") },
        { value: "presale", label: p("campaignPresale") },
      ],
      hint: p("campaignTypesHint"),
    },
    {
      name: "productStrategy",
      label: p("productStrategy"),
      type: "textarea",
      required: true,
      value: current?.productStrategy,
      showWhen: { name: "campaignTypes", values: ["product", "presale,product"] },
    },
    {
      name: "presaleStrategy",
      label: p("presaleStrategy"),
      type: "textarea",
      required: true,
      value: current?.presaleStrategy,
      showWhen: { name: "campaignTypes", values: ["presale", "presale,product"] },
    },
    {
      name: "voice",
      label: p("voice"),
      type: "textarea",
      required: true,
      value: profileLines(current?.voice),
    },
    color("primaryColor", "#0969FF"),
    color("secondaryColor", "#254D66"),
    color("accentColor", "#45C2FF"),
    color("backgroundColor", "#F6FBFF"),
    color("surfaceColor", "#FFFFFF"),
    color("textColor", "#071522"),
    {
      name: "headingFont",
      label: p("headingFont"),
      type: "select",
      value: visual.headingFont || "Inter",
      options: fonts,
    },
    {
      name: "bodyFont",
      label: p("bodyFont"),
      type: "select",
      value: visual.bodyFont || "Inter",
      options: fonts,
    },
    {
      name: "logoAssetId",
      label: p("logo"),
      type: "select",
      value: visual.logoAssetId || "",
      options: logoOptions,
      hint: p("logoHint"),
    },
    {
      name: "designRules",
      label: p("designRules"),
      type: "textarea",
      value: profileLines(visual.designRules),
      hint: p("designRulesHint"),
    },
    {
      name: "guardrails",
      label: p("guardrails"),
      type: "textarea",
      required: true,
      value: profileLines(current?.guardrails),
    },
    {
      name: "primaryCtas",
      label: p("primaryCtas"),
      type: "textarea",
      required: true,
      value: profileLines(current?.primaryCtas),
    },
    {
      name: "brandTerms",
      label: p("brandTerms"),
      type: "textarea",
      value: profileLines(current?.brandTerms),
      hint: p("brandTermsHint"),
    },
    {
      name: "channelPriority",
      label: p("channelPriority"),
      type: "textarea",
      required: true,
      value: profileLines(current?.channelPriority),
    },
    {
      name: "contentLanguage",
      label: p("contentLanguage"),
      type: "select",
      value: agentLanguage,
      options: (agentLanguages.length
        ? agentLanguages
        : AGENT_CONTENT_LANGUAGES
      ).map((code) => ({ value: code, label: languageName(code, locale) })),
      hint: p("contentLanguageHint"),
    },
    {
      name: "internalLanguage",
      label: p("internalLanguage"),
      type: "select",
      value: current?.internalLanguage || "de",
      options: [
        { value: "en", label: languageName("en", locale) },
        { value: "de", label: languageName("de", locale) },
      ],
    },
    {
      name: "notificationPreference",
      label: p("notificationPreference"),
      type: "select",
      value: current?.notificationPreference || "telegram",
      options: [
        { value: "telegram", label: p("telegramPreference") },
        { value: "slack", label: p("slackPreference") },
        { value: "none", label: p("none") },
      ],
    },
    ...candidates.map((link, index): FormField => ({
      name: link.key,
      label: `${link.label} · ${link.url}`,
      type: "checkbox",
      value: link.checked,
      ...(index === 0
        ? { heading: p("officialLinksHeading"), hint: p("officialLinkHint") }
        : {}),
    })),
  ];
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>{p("heading")}</h2>
          <p>{p("intro")}</p>
        </div>
        <Badge tone={current ? "success" : "warning"}>
          {current
            ? `${p("version")}${profile.data?.version}`
            : p("notConfigured")}
        </Badge>
      </div>
      <Alert>{p("telegramNote")}</Alert>
      {languageMissing && (
        <Alert kind="warning">
          {p("languageNotInProject", {
            code: String(current?.contentLanguage),
          })}
        </Alert>
      )}
      {current && (
        <div className="detail-grid">
          <div>
            <strong>{p("summaryProfile")}</strong>
            <p>
              {String(current.productName)} · {String(current.audience)}
            </p>
          </div>
          <div>
            <strong>{p("summaryStrategy")}</strong>
            <p>{p("summaryStrategyText")}</p>
          </div>
          <div>
            <strong>{p("summaryBrand")}</strong>
            <p>
              {(current.voice || []).join(" · ")} ·{" "}
              {visual.primaryColor || "#0969FF"}
            </p>
          </div>
          <div>
            <strong>{p("summaryLinks")}</strong>
            <p>
              {(current.officialLinks || [])
                .map((item: any) => item.label)
                .join(" · ")}
            </p>
          </div>
          <div>
            <strong>{p("summaryLanguage")}</strong>
            <p>{languageName(String(current.contentLanguage), locale)}</p>
          </div>
          <div>
            <strong>{p("summarySources")}</strong>
            <p>
              {p("sourcesAssets", {
                sources: sources.data?.items.length || 0,
                assets: libraryAssets(assets.data?.items).filter(
                  (asset) => asset.data.assetStatus === "approved",
                ).length,
              })}
            </p>
          </div>
          <div>
            <strong>{p("summaryRules")}</strong>
            <p>{p("summaryRulesText")}</p>
          </div>
          <div>
            <strong>{p("summaryNotifications")}</strong>
            <p>
              {p("preferenceOnly", {
                value: String(current.notificationPreference),
              })}
            </p>
          </div>
        </div>
      )}
      {isOwner && (
        <Button variant="outline" onClick={() => setEditing(true)}>
          {current ? p("edit") : p("configure")}
        </Button>
      )}
      {editing && (
        <Modal
          title={p("heading")}
          description={p("modalDescription")}
          onClose={() => {
            setEditing(false);
            setLinkError(false);
          }}
          wide
        >
          {!candidates.length && (
            <Alert kind="warning">{p("noCandidates")}</Alert>
          )}
          {unverified.length > 0 && (
            <Alert>
              {p("unverifiedLinks", {
                links: unverified.map((l) => l.label).join(", "),
              })}
            </Alert>
          )}
          {linkError && <Alert kind="error">{p("oneLinkRequired")}</Alert>}
          <DataForm
            fields={form}
            pending={mutation.pending}
            error={
              mutation.error === "MARKETING_PROFILE_VERSION_CONFLICT"
                ? p("versionConflict")
                : mutation.error
            }
            submitLabel={p("submit")}
            onCancel={() => {
              setEditing(false);
              setLinkError(false);
            }}
            onSubmit={(v) => {
              const officialLinks = candidates
                .filter((link) => v[link.key] === true)
                .map(({ label, factId, url }) => ({ label, factId, url }));
              if (!officialLinks.length) {
                setLinkError(true);
                return;
              }
              setLinkError(false);
              return mutation
                .run(async () =>
                  api(`/projects/${project.id}/marketing-profile`, {
                    method: "PUT",
                    body: JSON.stringify({
                      productName: str(v, "productName"),
                      contentLanguage: str(v, "contentLanguage"),
                      internalLanguage: str(v, "internalLanguage"),
                      audience: str(v, "audience"),
                      positioning: str(v, "positioning"),
                      // The version this edit started from: a change made
                      // meanwhile (also over MCP) is refused, not overwritten.
                      expectedVersion: profile.data?.version ?? 0,
                      campaignTypes: str(v, "campaignTypes").split(","),
                      // A hidden strategy keeps its saved text.
                      ...optionalText(
                        "productStrategy",
                        str(v, "productStrategy") || current?.productStrategy,
                      ),
                      ...optionalText(
                        "presaleStrategy",
                        str(v, "presaleStrategy") || current?.presaleStrategy,
                      ),
                      voice: profileCsv(str(v, "voice")),
                      guardrails: profileCsv(str(v, "guardrails")),
                      primaryCtas: profileCsv(str(v, "primaryCtas")),
                      channelPriority: profileCsv(str(v, "channelPriority")),
                      ...brandTermsField(str(v, "brandTerms")),
                      notificationPreference: str(v, "notificationPreference"),
                      officialLinks,
                      visualIdentity: {
                        primaryColor: str(v, "primaryColor"),
                        secondaryColor: str(v, "secondaryColor"),
                        accentColor: str(v, "accentColor"),
                        backgroundColor: str(v, "backgroundColor"),
                        surfaceColor: str(v, "surfaceColor"),
                        textColor: str(v, "textColor"),
                        headingFont: str(v, "headingFont"),
                        bodyFont: str(v, "bodyFont"),
                        ...(str(v, "logoAssetId")
                          ? { logoAssetId: str(v, "logoAssetId") }
                          : {}),
                        designRules: profileCsv(str(v, "designRules")),
                      },
                      assetPolicy: "approved_only",
                    }),
                  }),
                )
                .then((result) => {
                  if (result) setEditing(false);
                  // A refused save shows the version that is current now.
                  else profile.refresh();
                });
            }}
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
            options: libraryAssets(assets.data?.items)
              .filter(
                (e) =>
                  ["logo", "original_logo"].includes(String(e.data.type)) &&
                  e.data.usageApproved === true &&
                  e.data.assetStatus === "approved",
              )
              .map((e) => ({
                value: e.id,
                label: value(e, "name", value(e, "brandName", "Original logo")),
              })),
            hint: "Original branding and usage rights are required.",
          },
          {
            name: "visualAssetId",
            label: "Approved visual asset (optional)",
            type: "select",
            options: libraryAssets(assets.data?.items)
              .filter(
                (e) =>
                  !["logo", "original_logo"].includes(String(e.data.type)) &&
                  e.data.usageApproved === true &&
                  e.data.assetStatus === "approved" &&
                  e.data.hasContent === true,
              )
              .map((e) => ({
                value: e.id,
                label: value(e, "name", value(e, "filename", "Visual asset")),
              })),
            hint: "The image is composed behind the protected text surface.",
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
                ...(str(v, "visualAssetId")
                  ? { visualAssetId: str(v, "visualAssetId") }
                  : {}),
              }),
            )
            .then((r) => {
              if (r) {
                const response = r as Record<string, any>;
                const data = (
                  response.data && typeof response.data === "object"
                    ? response.data
                    : response
                ) as Record<string, unknown>;
                setResult({ ...data, assetId: response.id });
                if (response.id && data.mime === "image/png")
                  setDownload(
                    `/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(String(response.id))}/content`,
                  );
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

type OpenAiImageConfiguration = {
  configured: boolean;
  imageGeneration?: {
    model: string;
    maxCostMicrosPerImage: number;
    pricingVerifiedAt?: string;
  };
};

export function BrandAssetLibrary() {
  const { project, isOwner, refresh } = useWorkspace();
  const assets = useCollection("assets");
  const openAi = useResource<OpenAiImageConfiguration>(
    isOwner ? collectionPath(project.id, "openai-configuration") : null,
  );
  const mutation = useMutation(() => {
    assets.refresh();
    refresh();
  });
  const [mode, setMode] = useState<"upload" | "generate" | null>(null);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState("all");
  const [assetView, setAssetView] = useState<"grid" | "list">("grid");
  const visibleAssets = libraryAssets(assets.data?.items).filter((asset) => {
    const v = asset.data;
    const matchesQuery = String(v.name ?? v.filename ?? "")
      .toLowerCase()
      .includes(assetQuery.toLowerCase());
    const matchesFilter =
      assetFilter === "all" ||
      (assetFilter === "logos" &&
        ["logo", "original_logo"].includes(String(v.type))) ||
      (assetFilter === "images" && String(v.mime ?? "").startsWith("image/")) ||
      (assetFilter === "generated" && v.type === "generated_artwork") ||
      (assetFilter === "documents" &&
        !String(v.mime ?? "").startsWith("image/"));
    return matchesQuery && matchesFilter;
  });
  const imageConfig = openAi.data?.imageGeneration;
  const imageReady = Boolean(
    openAi.data?.configured &&
    imageConfig?.maxCostMicrosPerImage &&
    imageConfig.pricingVerifiedAt,
  );
  const contentUrl = (asset: Entity) =>
    asset.data.type === "original_logo"
      ? "/brand/logo-layer-stack-mark.svg"
      : `/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(asset.id)}/content`;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Brand kit &amp; asset library</h2>
          <p>
            Project-scoped originals, rights, approved variants and generated
            artwork.
          </p>
        </div>
        {isOwner && (
          <div className="page-actions">
            <Button variant="outline" onClick={() => setMode("upload")}>
              <Upload data-icon="inline-start" /> Upload asset
            </Button>
            <Button
              variant="outline"
              onClick={() => setMode("generate")}
              disabled={!imageReady}
              title={
                imageReady
                  ? undefined
                  : "Configure an OpenAI image model and cost ceiling first"
              }
            >
              <Sparkles data-icon="inline-start" /> Generate with OpenAI
            </Button>
          </div>
        )}
      </div>
      {!imageReady && isOwner && (
        <Alert kind="warning">
          OpenAI image generation remains disabled until an owner stores a key,
          verifies a GPT Image 2.5 model and sets a current maximum cost per
          image.
        </Alert>
      )}
      <div className="page-actions">
        <input
          aria-label="Search assets"
          placeholder="Search assets"
          value={assetQuery}
          onChange={(e) => setAssetQuery(e.target.value)}
        />
        <select
          aria-label="Asset category"
          value={assetFilter}
          onChange={(e) => setAssetFilter(e.target.value)}
        >
          {["all", "logos", "images", "generated", "documents"].map(
            (category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ),
          )}
        </select>
        <Button
          variant="outline"
          onClick={() => setAssetView(assetView === "grid" ? "list" : "grid")}
        >
          {assetView === "grid" ? "List view" : "Grid view"}
        </Button>
      </div>
      <div className={assetView === "grid" ? "asset-library" : "data-list"}>
        {visibleAssets.map((asset) => (
          <article className="asset-card" key={asset.id}>
            {asset.data.hasContent === true ||
            (asset.data.driveFileId &&
              String(asset.data.mime ?? "").startsWith("image/")) ||
            asset.data.type === "original_logo" ? (
              <img
                src={contentUrl(asset)}
                alt={value(
                  asset,
                  "name",
                  value(asset, "brandName", "Brand asset"),
                )}
              />
            ) : (
              <span className="asset-placeholder">
                <ImageIcon aria-hidden="true" />
              </span>
            )}
            <div>
              <strong>
                {value(asset, "name", value(asset, "brandName", "Asset"))}
              </strong>
              <p>{value(asset, "source", "Source not recorded")}</p>
              <p>
                {value(asset, "mime", "Unknown type")} ·{" "}
                {value(asset, "bytes", "Unknown size")} bytes
              </p>
              {typeof asset.data.driveFolderId === "string" && (
                <p>Drive folder: {String(asset.data.driveFolderId)}</p>
              )}
              <div className="detail-summary">
                <Status value={asset.data.assetStatus} />
                {typeof asset.data.driveSyncStatus === "string" && (
                  <Badge>{String(asset.data.driveSyncStatus)}</Badge>
                )}
                <Badge>{value(asset, "type")}</Badge>
              </div>
            </div>
            {(asset.data.hasContent === true ||
              typeof asset.data.driveFileId === "string") && (
              <a
                href={contentUrl(asset)}
                download={value(asset, "filename", "asset")}
              >
                Download
              </a>
            )}
            {typeof asset.data.driveFileId === "string" && (
              <a
                href={`https://drive.google.com/file/d/${encodeURIComponent(String(asset.data.driveFileId))}/view`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Drive
              </a>
            )}
            {asset.data.driveSyncStatus === "FAILED" && isOwner && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  mutation.run(() =>
                    api(
                      `/projects/${project.id}/assets/${asset.id}/drive-retry`,
                      { method: "POST" },
                    ),
                  )
                }
              >
                Retry Drive upload
              </Button>
            )}
            {isOwner && asset.data.type !== "original_logo" && (
              <div className="asset-actions">
                {asset.data.assetStatus !== "approved" && (
                  <Button
                    size="sm"
                    onClick={() =>
                      mutation.run(() =>
                        action(project.id, "asset-status", {
                          assetId: asset.id,
                          version: asset.version,
                          assetStatus: "approved",
                          confirmUsageRights: true,
                        }),
                      )
                    }
                  >
                    Approve rights &amp; use
                  </Button>
                )}
                {asset.data.assetStatus !== "outdated" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      mutation.run(() =>
                        action(project.id, "asset-status", {
                          assetId: asset.id,
                          version: asset.version,
                          assetStatus: "outdated",
                        }),
                      )
                    }
                  >
                    Mark outdated
                  </Button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mode === "upload" && (
        <Modal
          title="Upload brand asset"
          description="PNG, JPEG or WebP up to 1 MB. The server verifies the image signature, pixel bounds and strips metadata before storing a normalized PNG. Upload does not approve publication use."
          onClose={() => setMode(null)}
        >
          <DataForm
            fields={[
              { name: "name", label: "Asset name", required: true },
              {
                name: "type",
                label: "Asset type",
                type: "select",
                value: "photo",
                options: ["logo", "photo", "background", "banner", "icon"].map(
                  (value) => ({ value, label: value }),
                ),
              },
              {
                name: "file",
                label: "Image file",
                type: "file",
                accept: "image/png,image/jpeg,image/webp",
                required: true,
              },
              { name: "source", label: "Source / creator", required: true },
              {
                name: "license",
                label: "License / rights basis",
                required: true,
              },
              {
                name: "validUses",
                label: "Valid uses (comma separated)",
                value: "social, blog",
                required: true,
              },
              {
                name: "confirmRightsInformation",
                label:
                  "I confirm that the recorded source and rights information is accurate.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Upload as reference"
            onCancel={() => setMode(null)}
            onSubmit={(values) =>
              mutation
                .run(async () => {
                  const file = values.file;
                  if (!(file instanceof File))
                    throw new Error("ASSET_FILE_REQUIRED");
                  return api(`/projects/${project.id}/assets/upload`, {
                    method: "POST",
                    body: JSON.stringify({
                      name: str(values, "name"),
                      type: str(values, "type"),
                      mime: file.type,
                      base64: await fileBase64(file),
                      source: str(values, "source"),
                      license: str(values, "license"),
                      validUses: str(values, "validUses")
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                      confirmRightsInformation: true,
                    }),
                  });
                })
                .then((result) => {
                  if (result) setMode(null);
                })
            }
          />
        </Modal>
      )}
      {mode === "generate" && imageConfig && (
        <Modal
          title="Generate reference artwork"
          description="The prompt and brand palette are sent to OpenAI. The result is stored as an unapproved reference and cannot be published until an owner reviews its rights and brand fit."
          onClose={() => setMode(null)}
        >
          <Alert kind="warning">
            Model: {imageConfig.model}. Maximum reserved cost for this image: $
            {(imageConfig.maxCostMicrosPerImage / 1_000_000).toFixed(2)}.
          </Alert>
          <DataForm
            fields={[
              { name: "name", label: "Asset name", required: true },
              {
                name: "prompt",
                label: "Artwork description",
                type: "textarea",
                min: 10,
                max: 4000,
                required: true,
              },
              {
                name: "size",
                label: "Image size",
                type: "select",
                value: "1024x1024",
                options: ["1024x1024", "1536x1024", "1024x1536"].map(
                  (value) => ({ value, label: value }),
                ),
              },
              {
                name: "quality",
                label: "Quality",
                type: "select",
                value: "medium",
                options: ["low", "medium", "high"].map((value) => ({
                  value,
                  label: value,
                })),
              },
              {
                name: "background",
                label: "Background",
                type: "select",
                value: "opaque",
                options: ["opaque", "transparent"].map((value) => ({
                  value,
                  label: value,
                })),
              },
              {
                name: "channel",
                label: "Drive category",
                type: "select",
                value: "Other",
                options: [
                  "Social",
                  "Ads",
                  "Blog",
                  "Website",
                  "Campaigns",
                  "Other",
                ].map((value) => ({ value, label: value })),
              },
              {
                name: "platform",
                label: "Social channel",
                type: "select",
                value: "X",
                options: [
                  "X",
                  "Telegram",
                  "LinkedIn",
                  "Instagram",
                  "Facebook",
                ].map((value) => ({ value, label: value })),
                showWhen: { name: "channel", values: ["Social"] },
              },
              {
                name: "saveToDrive",
                label: "Save generated image to Google Drive when connected",
                type: "checkbox",
                value: true,
              },
              {
                name: "validUses",
                label: "Intended uses (comma separated)",
                value: "social, blog",
                required: true,
              },
              {
                name: "confirm",
                label: `I authorize sending this prompt and the project brand palette to OpenAI and reserve up to $${(imageConfig.maxCostMicrosPerImage / 1_000_000).toFixed(2)} for this single image.`,
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Generate one reference image"
            onCancel={() => setMode(null)}
            onSubmit={(values) =>
              mutation
                .run(() =>
                  api(`/projects/${project.id}/images/generate`, {
                    method: "POST",
                    body: JSON.stringify({
                      requestId: crypto.randomUUID(),
                      name: str(values, "name"),
                      prompt: str(values, "prompt"),
                      size: str(values, "size"),
                      quality: str(values, "quality"),
                      background: str(values, "background"),
                      validUses: str(values, "validUses")
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                      confirmPromptMayBeSentToOpenAI: true,
                      saveToDrive: values.saveToDrive === true,
                      channel: str(values, "channel"),
                      ...(values.platform
                        ? { platform: str(values, "platform") }
                        : {}),
                      confirmMaximumCostMicros:
                        imageConfig.maxCostMicrosPerImage,
                    }),
                  }),
                )
                .then((result) => {
                  if (result) setMode(null);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
