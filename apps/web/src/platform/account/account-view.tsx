"use client";
import { useState } from "react";
import { Monitor } from "lucide-react";
import {
  patch,
  post,
  remove,
  useMutation,
  useResource,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Loading } from "@/components/ui/primitives";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { DataForm, str } from "@/platform/ui/form";
import { useStandalone } from "@/platform/shell/standalone-context";
import { at, errorText } from "@/platform/administration/texts";

// The signed-in user's own account (/account, ADR 0012): name, language,
// e-mail address, password and sessions. Every change goes through the API,
// which checks the session and, where needed, the current password.

type Profile = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  locale: Locale | null;
  systemAdmin: boolean;
  /** Whether system mail lets the address be changed. */
  emailChange: boolean;
};
type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
};

export function AccountView() {
  const { locale, setLocale, refreshIdentity } = useStandalone();
  const de = locale === "de";
  const profile = useResource<Profile>("/account");
  const sessions = useResource<{ items: Session[] }>("/account/sessions");
  const save = useMutation(() => {
    profile.refresh();
    refreshIdentity?.();
  });
  const password = useMutation(sessions.refresh);
  const email = useMutation();
  const sessionAction = useMutation(sessions.refresh);
  const [passwordKey, setPasswordKey] = useState(0);
  if (profile.loading && !profile.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!profile.data)
    return <ResourceError error={profile.error} retry={profile.refresh} />;
  const p = profile.data;
  return (
    <div className="account-page">
      <PageHead
        title={de ? "Dein Konto" : "Your account"}
        description={
          de
            ? "Profil, Sprache, Anmeldung und Sitzungen. Gilt in allen Projekten."
            : "Profile, language, sign-in and sessions. Applies in every project."
        }
      />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "Profil" : "Profile"}</h2>
          </div>
        </div>
        <div className="panel-body">
          <DataForm
            fields={[
              { name: "name", label: "Name", required: true, value: p.name },
              {
                name: "locale",
                label: de ? "Sprache" : "Language",
                type: "select",
                value: p.locale ?? "",
                options: [
                  { value: "", label: de ? "Wie im Browser" : "As in the browser" },
                  { value: "en", label: "English" },
                  { value: "de", label: "Deutsch" },
                ],
              },
            ]}
            pending={save.pending}
            error={errorText(save.error, locale)}
            submitLabel={de ? "Speichern" : "Save"}
            onSubmit={async (v) => {
              const next = str(v, "locale");
              const done = await save.run(() =>
                patch("/account", {
                  name: str(v, "name"),
                  locale: next === "en" || next === "de" ? next : null,
                }),
              );
              if (done && (next === "en" || next === "de")) setLocale?.(next);
            }}
          />
          {save.success && (
            <Alert kind="success">{de ? "Gespeichert." : "Saved."}</Alert>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "E-Mail-Adresse" : "E-mail address"}</h2>
            <p>
              {p.email}{" "}
              {p.emailVerified && (
                <Badge tone="success">{de ? "bestätigt" : "verified"}</Badge>
              )}
            </p>
          </div>
        </div>
        <div className="panel-body">
          {p.emailChange ? (
            email.success ? (
              <Alert kind="success">
                {de
                  ? "Wir haben einen Bestätigungslink an die neue Adresse gesendet. Die Adresse ändert sich erst nach der Bestätigung."
                  : "We sent a confirmation link to the new address. The address changes only once it is confirmed."}
              </Alert>
            ) : (
              <DataForm
                fields={[
                  {
                    name: "newEmail",
                    label: de ? "Neue Adresse" : "New address",
                    type: "email",
                    required: true,
                  },
                  {
                    name: "password",
                    label: de ? "Aktuelles Passwort" : "Current password",
                    type: "password",
                    required: true,
                  },
                ]}
                pending={email.pending}
                error={errorText(email.error, locale)}
                submitLabel={de ? "Bestätigungslink senden" : "Send confirmation link"}
                onSubmit={(v) =>
                  void email.run(() =>
                    post("/account/email", {
                      newEmail: str(v, "newEmail"),
                      password: String(v.password),
                    }),
                  )
                }
              />
            )
          ) : (
            <p className="muted">
              {de
                ? "Ohne System-E-Mail kann nur die Administration die Adresse ändern."
                : "Without system e-mail only an administrator can change the address."}
            </p>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "Passwort" : "Password"}</h2>
            <p>{de ? "Mindestens 12 Zeichen." : "At least 12 characters."}</p>
          </div>
        </div>
        <div className="panel-body" key={passwordKey}>
          {password.success && (
            <Alert kind="success">
              {de ? "Passwort geändert." : "Password changed."}
            </Alert>
          )}
          <DataForm
            fields={[
              {
                name: "currentPassword",
                label: de ? "Aktuelles Passwort" : "Current password",
                type: "password",
                required: true,
              },
              {
                name: "newPassword",
                label: de ? "Neues Passwort" : "New password",
                type: "password",
                required: true,
              },
              {
                name: "revokeOtherSessions",
                label: de
                  ? "Alle anderen Sitzungen abmelden"
                  : "Sign out all other sessions",
                type: "checkbox",
                value: true,
              },
            ]}
            pending={password.pending}
            error={errorText(password.error, locale)}
            submitLabel={de ? "Passwort ändern" : "Change password"}
            onSubmit={async (v) => {
              const done = await password.run(() =>
                post("/account/password", {
                  currentPassword: String(v.currentPassword),
                  newPassword: String(v.newPassword),
                  revokeOtherSessions: Boolean(v.revokeOtherSessions),
                }),
              );
              if (done) setPasswordKey((k) => k + 1);
            }}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "Aktive Sitzungen" : "Active sessions"}</h2>
            <p>
              {de
                ? "Wo du angemeldet bist. Beende Sitzungen, die du nicht kennst."
                : "Where you are signed in. End sessions you do not recognize."}
            </p>
          </div>
          <div className="panel-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={
                sessionAction.pending ||
                (sessions.data?.items.filter((s) => !s.current).length ?? 0) === 0
              }
              onClick={() =>
                void sessionAction.run(() =>
                  post("/account/sessions/revoke-others", {}),
                )
              }
            >
              {de ? "Andere abmelden" : "Sign out others"}
            </Button>
          </div>
        </div>
        {sessionAction.error && (
          <Alert kind="error">{errorText(sessionAction.error, locale)}</Alert>
        )}
        {sessions.data ? (
          <div className="data-list">
            {sessions.data.items.map((s) => (
              <div key={s.id} className="data-row">
                <Monitor aria-hidden />
                <div>
                  <strong>
                    {s.userAgent ? shortAgent(s.userAgent) : de ? "Unbekanntes Gerät" : "Unknown device"}
                  </strong>
                  <p>
                    {de ? "Zuletzt aktiv" : "Last active"} {at(s.updatedAt, locale)}
                  </p>
                </div>
                {s.current ? (
                  <Badge tone="blue">{de ? "Diese Sitzung" : "This session"}</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={sessionAction.pending}
                    onClick={() =>
                      void sessionAction.run(() =>
                        remove(`/account/sessions/${encodeURIComponent(s.id)}`),
                      )
                    }
                  >
                    {de ? "Abmelden" : "Sign out"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <ResourceError error={sessions.error} retry={sessions.refresh} />
        )}
      </section>
    </div>
  );
}

/** A browser and system name from a user agent, for recognizing a session. */
export function shortAgent(agent: string) {
  const browser =
    /Edg\//.test(agent)
      ? "Edge"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : null;
  const system = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return [browser, system].filter(Boolean).join(" · ") || agent.slice(0, 60);
}
