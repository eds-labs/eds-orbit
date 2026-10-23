"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { post, useMutation } from "@/lib/api";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useStandalone } from "@/platform/shell/standalone-context";
import { errorText, orgRoleLabel, projectRoleLabel } from "@/platform/administration/texts";

// Pages opened from a one-time link (ADR 0012): accept an invitation, set a
// new password, confirm a new e-mail address. The token is in the URL's
// fragment, which never reaches a server log; the page reads it once and
// removes it from the address bar.

function useFragmentToken() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const value = window.location.hash.slice(1);
    setToken(/^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null);
    if (value)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, []);
  return token;
}

type InvitationView = {
  email: string;
  organization: string;
  role: "owner" | "member";
  projects: Array<{ name: string; role: string }>;
  expiresAt: string;
  existingAccount: boolean;
};

export function InviteView() {
  const { locale } = useStandalone();
  const de = locale === "de";
  const token = useFragmentToken();
  const view = useMutation();
  const accept = useMutation();
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  useEffect(() => {
    if (!token) return;
    void view
      .run(() => post<InvitationView>("/invitations/view", { token }))
      .then((v) => v && setInvitation(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (token === undefined || (token && !invitation && !view.error))
    return <Loading label={de ? "Einladung wird geprüft…" : "Checking the invitation…"} />;
  if (!token || !invitation)
    return (
      <div className="picker">
        <h1>{de ? "Einladung" : "Invitation"}</h1>
        <Alert kind="error">
          {errorText(view.error ?? "INVITATION_NOT_FOUND", locale)}
        </Alert>
      </div>
    );
  const done = async () => window.location.assign("/");
  return (
    <div className="picker">
      <h1>
        {de
          ? `Einladung zu ${invitation.organization}`
          : `Invitation to ${invitation.organization}`}
      </h1>
      <p>
        {de ? "Für" : "For"} <strong>{invitation.email}</strong> ·{" "}
        {orgRoleLabel(invitation.role, locale)}
        {invitation.projects.map((p) => (
          <span key={p.name}>
            {" · "}
            {p.name}: {projectRoleLabel(p.role, locale)}
          </span>
        ))}
      </p>
      {invitation.existingAccount ? (
        <>
          <p>
            {de
              ? "Für diese Adresse gibt es schon ein Konto. Melde dich an, um die Einladung anzunehmen."
              : "This address already has an account. Sign in to accept the invitation."}
          </p>
          <DataForm
            fields={[
              {
                name: "password",
                label: de ? "Passwort" : "Password",
                type: "password",
                required: true,
              },
            ]}
            pending={accept.pending}
            error={errorText(accept.error, locale)}
            submitLabel={de ? "Anmelden und annehmen" : "Sign in and accept"}
            onSubmit={async (v) => {
              const ok = await accept.run(async () => {
                await post("/auth/sign-in/email", {
                  email: invitation.email,
                  password: String(v.password),
                });
                return post("/invitations/accept", { token });
              });
              if (ok) await done();
            }}
          />
        </>
      ) : (
        <DataForm
          fields={[
            { name: "name", label: de ? "Dein Name" : "Your name", required: true },
            {
              name: "password",
              label: de ? "Passwort festlegen" : "Choose a password",
              type: "password",
              required: true,
              hint: de ? "Mindestens 12 Zeichen." : "At least 12 characters.",
            },
            {
              name: "repeat",
              label: de ? "Passwort wiederholen" : "Repeat the password",
              type: "password",
              required: true,
            },
          ]}
          pending={accept.pending}
          error={errorText(accept.error, locale)}
          submitLabel={de ? "Konto anlegen und annehmen" : "Create account and accept"}
          onSubmit={async (v) => {
            const ok = await accept.run(async () => {
              if (v.password !== v.repeat)
                throw new Error(
                  de ? "Die Passwörter sind verschieden." : "The passwords differ.",
                );
              return post("/invitations/accept", {
                token,
                name: str(v, "name"),
                password: String(v.password),
              });
            });
            if (ok) await done();
          }}
        />
      )}
    </div>
  );
}

export function ResetPasswordView() {
  const { locale } = useStandalone();
  const de = locale === "de";
  const token = useFragmentToken();
  const request = useMutation();
  const confirm = useMutation();
  if (token === undefined) return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (confirm.success)
    return (
      <div className="picker">
        <h1>{de ? "Passwort geändert" : "Password changed"}</h1>
        <Alert kind="success">
          {de
            ? "Alle Sitzungen wurden abgemeldet. Melde dich mit dem neuen Passwort an."
            : "All sessions were signed out. Sign in with the new password."}
        </Alert>
        <Button asChild>
          <Link href="/">{de ? "Zur Anmeldung" : "Go to sign-in"}</Link>
        </Button>
      </div>
    );
  if (token)
    return (
      <div className="picker">
        <h1>{de ? "Neues Passwort festlegen" : "Set a new password"}</h1>
        <DataForm
          fields={[
            {
              name: "password",
              label: de ? "Neues Passwort" : "New password",
              type: "password",
              required: true,
              hint: de ? "Mindestens 12 Zeichen." : "At least 12 characters.",
            },
            {
              name: "repeat",
              label: de ? "Passwort wiederholen" : "Repeat the password",
              type: "password",
              required: true,
            },
          ]}
          pending={confirm.pending}
          error={errorText(confirm.error, locale)}
          submitLabel={de ? "Passwort speichern" : "Save password"}
          onSubmit={(v) =>
            void confirm.run(async () => {
              if (v.password !== v.repeat)
                throw new Error(
                  de ? "Die Passwörter sind verschieden." : "The passwords differ.",
                );
              return post("/account/password-reset/confirm", {
                token,
                newPassword: String(v.password),
              });
            })
          }
        />
      </div>
    );
  return (
    <div className="picker">
      <h1>{de ? "Passwort vergessen" : "Forgot your password"}</h1>
      <p>
        {de
          ? "Wir senden dir einen Link, der eine Stunde gültig ist."
          : "We send you a link that is valid for one hour."}
      </p>
      {request.success ? (
        <Alert kind="success">
          {de
            ? "Wenn ein aktives Konto zu dieser Adresse gehört, ist der Link unterwegs."
            : "If an active account belongs to this address, the link is on its way."}
        </Alert>
      ) : (
        <DataForm
          fields={[{ name: "email", label: "E-Mail", type: "email", required: true }]}
          pending={request.pending}
          error={errorText(request.error, locale)}
          submitLabel={de ? "Link senden" : "Send link"}
          onSubmit={(v) =>
            void request.run(() =>
              post("/account/password-reset/request", { email: str(v, "email") }),
            )
          }
        />
      )}
      <p>
        <Link href="/">{de ? "Zurück zur Anmeldung" : "Back to sign-in"}</Link>
      </p>
    </div>
  );
}

export function ConfirmEmailView() {
  const { locale, refreshIdentity } = useStandalone();
  const de = locale === "de";
  const token = useFragmentToken();
  const confirm = useMutation(refreshIdentity);
  if (token === undefined) return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  return (
    <div className="picker">
      <h1>{de ? "Neue Adresse bestätigen" : "Confirm your new address"}</h1>
      {confirm.success ? (
        <Alert kind="success">
          {de ? "Deine Anmeldeadresse wurde geändert." : "Your sign-in address was changed."}
        </Alert>
      ) : token ? (
        <>
          {confirm.error && (
            <Alert kind="error">{errorText(confirm.error, locale)}</Alert>
          )}
          <Button
            disabled={confirm.pending}
            onClick={() =>
              void confirm.run(() => post("/account/email/confirm", { token }))
            }
          >
            {de ? "Adresse bestätigen" : "Confirm address"}
          </Button>
        </>
      ) : (
        <Alert kind="error">{errorText("INVALID_TOKEN", locale)}</Alert>
      )}
      <p>
        <Link href="/account">{de ? "Zum Konto" : "To your account"}</Link>
      </p>
    </div>
  );
}
