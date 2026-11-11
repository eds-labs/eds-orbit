"use client";
import { AppLink } from "@/platform/ui/app-link";
import { useWorkspace } from "@/components/workspace-context";
import { exceptionText, hasExceptionText } from "@/lib/exception-text";

/**
 * A code in words (plan 2026-11-10, WP2 D): what happened, why and what to
 * do, with the setting that resolves it. A code with its own text speaks the
 * member's language even when the server stored an English title or message
 * (the Postiz queue watch does); a stored title or message is shown only for
 * codes without one, and a code without either keeps showing the code. The
 * raw code stays readable under "Technical details". Shared by open
 * exceptions and by the reason an agent-approved draft waits for the owner.
 */
export function ExceptionWords({
  code,
  storedTitle = "",
  storedMessage = "",
}: {
  code: string;
  storedTitle?: string;
  storedMessage?: string;
}) {
  const { locale } = useWorkspace();
  const de = locale === "de";
  const text = exceptionText(locale, code);
  const known = hasExceptionText(code);
  const title = known ? text.title : storedTitle || text.title;
  const stored = known ? "" : storedMessage;
  const cause = stored || text.cause;
  return (
    <>
      <strong>{title}</strong>
      {cause && <p>{cause}</p>}
      {!stored && text.action && (
        <p>
          {text.action}{" "}
          {text.href && (
            <AppLink href={text.href}>
              {de ? "Einstellung öffnen" : "Open the setting"}
            </AppLink>
          )}
        </p>
      )}
      {code && title !== code && (
        <details className="approval-diagnostics">
          <summary>{de ? "Technische Details" : "Technical details"}</summary>
          <code>{code}</code>
        </details>
      )}
    </>
  );
}
