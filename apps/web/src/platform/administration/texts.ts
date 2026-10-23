import type { Locale } from "@/lib/i18n";

// Wording shared by the administration, organization and account pages
// (ADR 0012). Server errors arrive as codes; these turn the expected ones
// into sentences and leave the rest to the generic message.

const errors: Record<string, { en: string; de: string }> = {
  LAST_OWNER: {
    en: "An organization needs at least one active owner.",
    de: "Eine Organisation braucht mindestens einen aktiven Owner.",
  },
  LAST_ADMIN: {
    en: "The installation needs at least one active administrator.",
    de: "Die Installation braucht mindestens eine aktive Administration.",
  },
  CANNOT_DEACTIVATE_SELF: {
    en: "You cannot deactivate your own account.",
    de: "Du kannst dein eigenes Konto nicht deaktivieren.",
  },
  CANNOT_DEMOTE_SELF: {
    en: "You cannot remove your own administrator role.",
    de: "Du kannst deine eigene Administratorrolle nicht entfernen.",
  },
  INVALID_PASSWORD: {
    en: "The password is not correct.",
    de: "Das Passwort ist nicht korrekt.",
  },
  WORKSPACE_OWNER_REQUIRED: {
    en: "Only an organization owner can do this.",
    de: "Das kann nur ein Owner der Organisation.",
  },
  USER_DEACTIVATED: {
    en: "This account is deactivated.",
    de: "Dieses Konto ist deaktiviert.",
  },
  INVITATION_NOT_FOUND: {
    en: "This invitation link is invalid, expired or already used.",
    de: "Dieser Einladungslink ist ungültig, abgelaufen oder bereits verwendet.",
  },
  INVITATION_NO_LONGER_VALID: {
    en: "This invitation is no longer valid. Ask for a new one.",
    de: "Diese Einladung gilt nicht mehr. Bitte fordere eine neue an.",
  },
  INVITATION_EMAIL_MISMATCH: {
    en: "This invitation is for another e-mail address.",
    de: "Diese Einladung gilt für eine andere E-Mail-Adresse.",
  },
  ACCOUNT_EXISTS: {
    en: "An account with this address exists. Sign in to accept.",
    de: "Für diese Adresse gibt es ein Konto. Melde dich an, um anzunehmen.",
  },
  INVALID_TOKEN: {
    en: "This link is invalid or expired. Request a new one.",
    de: "Dieser Link ist ungültig oder abgelaufen. Fordere einen neuen an.",
  },
  EMAIL_IN_USE: {
    en: "This address is already used by another account.",
    de: "Diese Adresse wird schon von einem anderen Konto verwendet.",
  },
  SYSTEM_MAIL_UNAVAILABLE: {
    en: "System e-mail is not configured for this installation.",
    de: "Für diese Installation ist kein System-E-Mail-Versand eingerichtet.",
  },
  INVITATIONS_DISABLED: {
    en: "Only members of the organization can be added while invitations are off.",
    de: "Solange Einladungen aus sind, können nur Mitglieder der Organisation hinzugefügt werden.",
  },
  OWNER_HAS_NO_MODULE_ROLES: {
    en: "Owners keep their role in every module.",
    de: "Owner behalten ihre Rolle in jedem Modul.",
  },
  PASSWORD_TOO_SHORT: {
    en: "Use at least 12 characters.",
    de: "Verwende mindestens 12 Zeichen.",
  },
};

/** A readable message for an error a mutation reported. */
export function errorText(message: string | null | undefined, locale: Locale) {
  if (!message) return null;
  const code = message.replaceAll(" ", "_");
  return errors[code]?.[locale] ?? message;
}

export const projectRoleLabel = (role: string, locale: Locale) =>
  ({
    owner: "Owner",
    editor: locale === "de" ? "Bearbeiten" : "Editor",
    viewer: locale === "de" ? "Lesen" : "Viewer",
  })[role] ?? role;

export const orgRoleLabel = (role: string, locale: Locale) =>
  role === "owner" ? "Owner" : locale === "de" ? "Mitglied" : "Member";

/** A date and time in the viewer's language; "—" when unknown. */
export function at(value: string | null | undefined, locale: Locale) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
