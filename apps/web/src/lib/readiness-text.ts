import type { Locale } from "./i18n";

// The publish_* rows show publishing on the project's backend (Postiz or
// Social); on Postiz they equal postiz_*, so those are not listed twice.
export const actionOrder = [
  "chat",
  "knowledge_search",
  "text_draft",
  "internal_review",
  "export",
  "visual",
  "drive_save",
  "matomo",
  "publish_draft",
  "publish_schedule",
  "publish_live",
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
    publish_draft: "Draft handoff",
    publish_schedule: "Post scheduling",
    publish_live: "Live post",
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
    publish_draft: "Entwurf übergeben",
    publish_schedule: "Beiträge planen",
    publish_live: "Livepost",
    blog_live: "Blog veröffentlichen",
    newsletter_live: "Newsletter versenden",
    ads_live: "Ads aktivieren",
  },
};

const blockerReasons: Record<Locale, Record<string, string>> = {
  en: {
    PROJECT_PAUSED: "The project is paused.",
    // The code keeps its historical name; the check covers every provider.
    VERIFIED_OPENAI_MODELS_REQUIRED:
      "Add a key for the provider of the chat and draft routes, with verified, priced models.",
    OWNER_POLICY_REQUIRED: "An owner needs to activate a current policy.",
    APPROVED_PAID_BUDGET_REQUIRED:
      "The policy needs an approved AI spend limit.",
    CURRENT_PUBLIC_KNOWLEDGE_REQUIRED:
      "Add a current public source with verified facts.",
    LIVE_RAG_EVAL_REQUIRED:
      "The active knowledge index needs a current, passed live evaluation.",
    MARKETING_PROFILE_REQUIRED: "Save a marketing profile.",
    POLICY_CHANNELS_REQUIRED: "The policy needs channels and content types.",
    IMAGE_KEY_REQUIRED: "Add an OpenAI key for image generation.",
    IMAGE_PRICING_REQUIRED: "Confirm the current image price and limit.",
    IMAGE_MODEL_NOT_VERIFIED: "Verify the selected image model.",
    DRIVE_CLIENT_NOT_CONFIGURED: "Google Drive is not set up on the server.",
    DRIVE_NOT_CONNECTED: "Connect a Google Drive account.",
    DRIVE_ROOT_REQUIRED: "Choose and enable a Drive root folder.",
    GOOGLE_DRIVE_RECONNECT_REQUIRED:
      "Google rejected the Drive access token. Reconnect Google Drive.",
    POSTIZ_NOT_CONNECTED: "Connect and verify Postiz.",
    POSTIZ_CHANNELS_NOT_ASSIGNED: "Assign Postiz channels to this project.",
    POSTIZ_DRAFTS_DISABLED:
      "Postiz draft handoff is switched off (ENABLE_POSTIZ_DRAFTS).",
    PUBLISHER_WRITE_VERIFICATION_REQUIRED:
      "Postiz write access has not been verified.",
    CHANNEL_WRITE_VERIFICATION_REQUIRED:
      "Each policy channel needs a verified Postiz write.",
    PUBLISHING_BACKEND_DRAINING:
      "Postiz is finishing the posts it holds; new posts wait for the switch to Social.",
    PUBLISHING_BACKEND_SOCIAL:
      "This project publishes through Social, not Postiz.",
    SOCIAL_DISABLED: "The Social module is off for this project.",
    SOCIAL_CHANNEL_NOT_MAPPED:
      "A policy channel has no connected Social account.",
    SOCIAL_ACCOUNT_NOT_ACTIVE:
      "A Social account of a policy channel needs to be reconnected.",
    SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED:
      "Posting has not been verified on a Social account of a policy channel.",
    SOCIAL_PLATFORM_NOT_AVAILABLE:
      "Posting to a policy channel's platform is not switched on.",
    SOCIAL_MEDIA_PUBLIC_REQUIRED:
      "Instagram needs public media links, which are switched off.",
    AUTOPILOT_ON_SOCIAL_NOT_APPROVED:
      "Live autopilot through Social needs the owner's switch “Autopilot through Social” (Administration & settings → Modules → Marketing → Publishing rules); while Postiz drains it stays off.",
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
      "Schlüssel für den Anbieter der Chat- und Entwurfsrouten mit geprüften, bepreisten Modellen hinterlegen.",
    OWNER_POLICY_REQUIRED: "Ein Owner muss eine aktuelle Policy aktivieren.",
    APPROVED_PAID_BUDGET_REQUIRED:
      "Die Policy braucht ein freigegebenes KI-Kostenlimit.",
    CURRENT_PUBLIC_KNOWLEDGE_REQUIRED:
      "Aktuelle öffentliche Quelle mit bestätigten Fakten hinzufügen.",
    LIVE_RAG_EVAL_REQUIRED:
      "Der aktive Wissensindex braucht eine aktuelle, bestandene Live-Evaluation.",
    MARKETING_PROFILE_REQUIRED: "Marketingprofil speichern.",
    POLICY_CHANNELS_REQUIRED: "Die Policy braucht Kanäle und Inhaltstypen.",
    IMAGE_KEY_REQUIRED: "OpenAI-Schlüssel für Bilderzeugung hinterlegen.",
    IMAGE_PRICING_REQUIRED: "Aktuellen Bildpreis und Limit bestätigen.",
    IMAGE_MODEL_NOT_VERIFIED: "Gewähltes Bildmodell prüfen.",
    DRIVE_CLIENT_NOT_CONFIGURED:
      "Google Drive ist auf dem Server nicht eingerichtet.",
    DRIVE_NOT_CONNECTED: "Google-Drive-Konto verbinden.",
    DRIVE_ROOT_REQUIRED: "Drive-Stammordner wählen und aktivieren.",
    GOOGLE_DRIVE_RECONNECT_REQUIRED:
      "Google hat den Drive-Zugriff abgelehnt. Google Drive erneut verbinden.",
    POSTIZ_NOT_CONNECTED: "Postiz verbinden und prüfen.",
    POSTIZ_CHANNELS_NOT_ASSIGNED: "Postiz-Kanäle diesem Projekt zuweisen.",
    POSTIZ_DRAFTS_DISABLED:
      "Entwürfe an Postiz sind ausgeschaltet (ENABLE_POSTIZ_DRAFTS).",
    PUBLISHER_WRITE_VERIFICATION_REQUIRED:
      "Schreibzugriff auf Postiz ist noch nicht geprüft.",
    CHANNEL_WRITE_VERIFICATION_REQUIRED:
      "Jeder Policy-Kanal braucht einen geprüften Postiz-Schreibtest.",
    PUBLISHING_BACKEND_DRAINING:
      "Postiz arbeitet seine übergebenen Beiträge ab; neue Beiträge warten auf den Wechsel zu Social.",
    PUBLISHING_BACKEND_SOCIAL:
      "Dieses Projekt veröffentlicht über Social, nicht über Postiz.",
    SOCIAL_DISABLED: "Das Social-Modul ist für dieses Projekt ausgeschaltet.",
    SOCIAL_CHANNEL_NOT_MAPPED:
      "Ein Policy-Kanal hat kein verbundenes Social-Konto.",
    SOCIAL_ACCOUNT_NOT_ACTIVE:
      "Ein Social-Konto eines Policy-Kanals muss neu verbunden werden.",
    SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED:
      "Das Posten auf einem Social-Konto eines Policy-Kanals ist noch nicht geprüft.",
    SOCIAL_PLATFORM_NOT_AVAILABLE:
      "Das Posten auf der Plattform eines Policy-Kanals ist nicht eingeschaltet.",
    SOCIAL_MEDIA_PUBLIC_REQUIRED:
      "Instagram braucht öffentliche Medien-Links, die ausgeschaltet sind.",
    AUTOPILOT_ON_SOCIAL_NOT_APPROVED:
      "Live-Autopilot über Social braucht den Schalter „Autopilot über Social“ des Owners (Verwaltung & Einstellungen → Module → Marketing → Veröffentlichungsregeln); solange Postiz ausläuft, bleibt er aus.",
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

/**
 * A refused live activation (`LIVE_ACTIVATION_BLOCKED:<code>,<code>` from a
 * policy save) in words; any other message unchanged.
 */
export function activationErrorText(
  locale: Locale,
  message: string | null,
): string | null {
  const prefix = "LIVE_ACTIVATION_BLOCKED:";
  if (!message?.startsWith(prefix)) return message;
  return message
    .slice(prefix.length)
    .split(",")
    .filter(Boolean)
    .map((code) => blockerReason(locale, code))
    .join(" ");
}
