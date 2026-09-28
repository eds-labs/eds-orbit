import type { Locale } from "./i18n";

export const actionOrder = [
  "chat",
  "knowledge_search",
  "text_draft",
  "internal_review",
  "export",
  "visual",
  "drive_save",
  "matomo",
  "postiz_draft",
  "postiz_schedule",
  "postiz_live",
  "blog_live",
  "newsletter_live",
  "ads_live",
] as const;

const actionLabels: Record<Locale, Record<string, string>> = {
  en: {
    chat: "Orbit Chat",
    knowledge_search: "Knowledge search",
    text_draft: "Text draft",
    internal_review: "Internal review",
    export: "Export",
    visual: "Branded visual",
    drive_save: "Save to Drive",
    matomo: "Matomo analytics",
    postiz_draft: "Postiz draft handoff",
    postiz_schedule: "Postiz scheduling",
    postiz_live: "Postiz live post",
    blog_live: "Blog publishing",
    newsletter_live: "Newsletter sending",
    ads_live: "Ads activation",
  },
  de: {
    chat: "Orbit Chat",
    knowledge_search: "Wissenssuche",
    text_draft: "Textentwurf",
    internal_review: "Interne Prüfung",
    export: "Export",
    visual: "Marken-Visual",
    drive_save: "In Drive speichern",
    matomo: "Matomo-Analysen",
    postiz_draft: "Entwurf an Postiz",
    postiz_schedule: "Postiz-Planung",
    postiz_live: "Postiz-Livepost",
    blog_live: "Blog veröffentlichen",
    newsletter_live: "Newsletter versenden",
    ads_live: "Ads aktivieren",
  },
};

const blockerReasons: Record<Locale, Record<string, string>> = {
  en: {
    PROJECT_PAUSED: "The project is paused.",
    VERIFIED_OPENAI_MODELS_REQUIRED: "Add an OpenAI key with verified models.",
    OWNER_POLICY_REQUIRED: "An owner needs to activate a current policy.",
    APPROVED_PAID_BUDGET_REQUIRED:
      "The policy needs an approved AI spend limit.",
    CURRENT_PUBLIC_KNOWLEDGE_REQUIRED:
      "Add a current public source with verified facts.",
    MARKETING_PROFILE_REQUIRED: "Save a marketing profile.",
    POLICY_CHANNELS_REQUIRED: "The policy needs channels and content types.",
    IMAGE_KEY_REQUIRED: "Add an OpenAI key for image generation.",
    IMAGE_PRICING_REQUIRED: "Confirm the current image price and limit.",
    IMAGE_MODEL_NOT_VERIFIED: "Verify the selected image model.",
    DRIVE_CLIENT_NOT_CONFIGURED: "Google Drive is not set up on the server.",
    DRIVE_NOT_CONNECTED: "Connect a Google Drive account.",
    DRIVE_ROOT_REQUIRED: "Choose and enable a Drive root folder.",
    POSTIZ_NOT_CONNECTED: "Connect and verify Postiz.",
    POSTIZ_CHANNELS_NOT_ASSIGNED: "Assign Postiz channels to this project.",
    POSTIZ_DRAFT_HANDOFF_NOT_AVAILABLE:
      "Sending drafts to Postiz is not available yet.",
    PUBLISHER_WRITE_VERIFICATION_REQUIRED:
      "Postiz write access has not been verified.",
    CHANNEL_WRITE_VERIFICATION_REQUIRED:
      "Each policy channel needs a verified Postiz write.",
    EXECUTION_MODE_TEST: "Orbit runs in test mode; live posts are off.",
    EXTERNAL_WRITES_DISABLED: "External writes are switched off.",
    MATOMO_READ_VERIFICATION_REQUIRED: "Connect and verify Matomo.",
    BLOG_TARGET_NOT_CONFIGURED: "No blog target is configured.",
    MAIL_PROVIDER_NOT_CONFIGURED: "No mail provider is configured.",
    ADS_WRITE_MANDATE_NOT_CONFIGURED: "No ads mandate is configured.",
  },
  de: {
    PROJECT_PAUSED: "Das Projekt ist pausiert.",
    VERIFIED_OPENAI_MODELS_REQUIRED:
      "OpenAI-Schlüssel mit geprüften Modellen hinterlegen.",
    OWNER_POLICY_REQUIRED: "Ein Owner muss eine aktuelle Policy aktivieren.",
    APPROVED_PAID_BUDGET_REQUIRED:
      "Die Policy braucht ein freigegebenes KI-Kostenlimit.",
    CURRENT_PUBLIC_KNOWLEDGE_REQUIRED:
      "Aktuelle öffentliche Quelle mit bestätigten Fakten hinzufügen.",
    MARKETING_PROFILE_REQUIRED: "Marketingprofil speichern.",
    POLICY_CHANNELS_REQUIRED: "Die Policy braucht Kanäle und Inhaltstypen.",
    IMAGE_KEY_REQUIRED: "OpenAI-Schlüssel für Bilderzeugung hinterlegen.",
    IMAGE_PRICING_REQUIRED: "Aktuellen Bildpreis und Limit bestätigen.",
    IMAGE_MODEL_NOT_VERIFIED: "Gewähltes Bildmodell prüfen.",
    DRIVE_CLIENT_NOT_CONFIGURED:
      "Google Drive ist auf dem Server nicht eingerichtet.",
    DRIVE_NOT_CONNECTED: "Google-Drive-Konto verbinden.",
    DRIVE_ROOT_REQUIRED: "Drive-Stammordner wählen und aktivieren.",
    POSTIZ_NOT_CONNECTED: "Postiz verbinden und prüfen.",
    POSTIZ_CHANNELS_NOT_ASSIGNED: "Postiz-Kanäle diesem Projekt zuweisen.",
    POSTIZ_DRAFT_HANDOFF_NOT_AVAILABLE:
      "Entwürfe an Postiz senden ist noch nicht verfügbar.",
    PUBLISHER_WRITE_VERIFICATION_REQUIRED:
      "Schreibzugriff auf Postiz ist noch nicht geprüft.",
    CHANNEL_WRITE_VERIFICATION_REQUIRED:
      "Jeder Policy-Kanal braucht einen geprüften Postiz-Schreibtest.",
    EXECUTION_MODE_TEST: "Orbit läuft im Testmodus; Liveposts sind aus.",
    EXTERNAL_WRITES_DISABLED: "Externe Schreibzugriffe sind ausgeschaltet.",
    MATOMO_READ_VERIFICATION_REQUIRED: "Matomo verbinden und prüfen.",
    BLOG_TARGET_NOT_CONFIGURED: "Kein Blog-Ziel eingerichtet.",
    MAIL_PROVIDER_NOT_CONFIGURED: "Kein Mail-Anbieter eingerichtet.",
    ADS_WRITE_MANDATE_NOT_CONFIGURED: "Kein Ads-Mandat eingerichtet.",
  },
};

export function actionLabel(locale: Locale, action: string) {
  return actionLabels[locale][action] ?? action.replaceAll("_", " ");
}

export function blockerReason(locale: Locale, code: string) {
  return blockerReasons[locale][code] ?? code.replaceAll("_", " ");
}
