"use client";
import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import { Alert, Button } from "@/components/ui/primitives";
import type { SocialAppReadiness } from "./api";
import { socialText } from "./labels";

// What a missing developer app means for the accounts page (ADR 0020): a
// notice per app that names who acts where. A project that does not use a
// platform hides its notice and connect button; the choice is a per-browser
// convenience in localStorage, and a granted or broken app shows again.

export type SocialApp = keyof SocialAppReadiness;
type AppState = Exclude<SocialAppReadiness[SocialApp], "ready">;

const APPS: readonly SocialApp[] = ["x", "meta"];
const key = (projectId: string) => `orbit.social.hiddenApps.${projectId}`;

/** The apps whose notice this browser hides in the project; empty without storage. */
export function readHiddenApps(projectId: string): Set<SocialApp> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(projectId)) ?? "[]");
    return new Set(Array.isArray(value) ? APPS.filter((app) => value.includes(app)) : []);
  } catch {
    return new Set();
  }
}

export function writeHiddenApps(projectId: string, apps: ReadonlySet<SocialApp>): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify([...apps]));
  } catch {
    /* The notice then shows again on the next visit. */
  }
}

/** Only a missing grant can be hidden; broken keys always need an administrator. */
const hideable = (state: SocialAppReadiness[SocialApp] | undefined) =>
  state === "not_granted" || state === "project_not_granted";

/** The hidden apps that are still missing for the project. */
export function appsToHide(readiness: SocialAppReadiness | null | undefined, hidden: ReadonlySet<SocialApp>): SocialApp[] {
  return readiness ? APPS.filter((app) => hidden.has(app) && hideable(readiness[app])) : [];
}

export function AppHint({
  app,
  state,
  settingsHref,
  locale,
  onHide,
}: {
  app: SocialApp;
  state: AppState;
  /** The organization settings, for members who may open them. */
  settingsHref: string | null;
  locale: Locale;
  onHide: () => void;
}) {
  const t = socialText(locale).accounts;
  const text =
    state === "invalid" ? t.appInvalid[app] : state === "project_not_granted" ? t.appProjectNotGranted[app] : t.appNotGranted[app];
  return (
    <Alert kind="warning">
      <p>{text}</p>
      {state === "project_not_granted" && settingsHref && (
        <>
          <Button asChild size="sm" variant="outline">
            <Link href={settingsHref}>{t.openSettings}</Link>
          </Button>{" "}
        </>
      )}
      {hideable(state) && (
        <Button size="sm" variant="ghost" onClick={onHide} aria-label={t.hideAppLabel(t.appName[app])}>
          {t.hideApp}
        </Button>
      )}
    </Alert>
  );
}

export function HiddenAppsNote({
  apps,
  locale,
  onShow,
}: {
  apps: readonly SocialApp[];
  locale: Locale;
  onShow: () => void;
}) {
  const t = socialText(locale).accounts;
  return (
    <p className="field-hint">
      {t.hiddenApps(apps.map((app) => t.appName[app]).join(", "))}{" "}
      <Button size="sm" variant="ghost" onClick={onShow}>
        {t.showApps}
      </Button>
    </p>
  );
}
