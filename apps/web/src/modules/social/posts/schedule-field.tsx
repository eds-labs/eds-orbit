"use client";
import { Button, Field, FieldLabel, Input } from "@/components/ui/primitives";
import { postMessage, socialText } from "../labels";

// The publication time of a post (S4): a date and a time in the post's
// zone. When the clocks change, a time may not exist (the server suggests
// the next valid one) or exist twice (the person chooses earlier or later).

export type ScheduleChoice = { label: string; fold?: "earlier" | "later"; local?: string };

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** "UTC+02:00": the offset a local time has at an instant. */
function offsetLabel(local: string, instant: string) {
  const minutes = Math.round((Date.parse(`${local}:00Z`) - Date.parse(instant)) / 60_000);
  return `UTC${minutes < 0 ? "-" : "+"}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "28.03.2027, 03:00" (de) or "2027-03-28 03:00" (en). */
function localLabel(local: string, locale: "en" | "de") {
  const [date = "", time = ""] = local.split("T");
  const [y, m, d] = date.split("-");
  return locale === "de" ? `${d}.${m}.${y}, ${time}` : `${date} ${time}`;
}

/** What to show for a schedule error, with the choices that resolve it. */
export function scheduleErrorView(
  code: string,
  detail: unknown,
  local: string,
  locale: "en" | "de",
): { message: string; choices?: ScheduleChoice[] } {
  const t = socialText(locale).posts;
  const message = postMessage(code, locale);
  const d = (detail ?? {}) as Record<string, unknown>;
  if (code === "SOCIAL_SCHEDULE_TIME_AMBIGUOUS" && typeof d.earlier === "string" && typeof d.later === "string")
    return {
      message,
      choices: [
        { label: `${t.earlier} (${offsetLabel(local, d.earlier)})`, fold: "earlier" },
        { label: `${t.later} (${offsetLabel(local, d.later)})`, fold: "later" },
      ],
    };
  if (code === "SOCIAL_SCHEDULE_TIME_GAP" && typeof d.suggestedLocal === "string")
    return { message, choices: [{ label: t.useTime(localLabel(d.suggestedLocal, locale)), local: d.suggestedLocal }] };
  return { message };
}

export function ScheduleField({
  date,
  time,
  timeZone,
  locale,
  disabled,
  onChange,
  error,
  onChoice,
}: {
  date: string;
  time: string;
  timeZone: string;
  locale: "en" | "de";
  disabled?: boolean;
  onChange: (next: { date: string; time: string }) => void;
  error: { message: string; choices?: ScheduleChoice[] } | null;
  onChoice: (choice: ScheduleChoice) => void;
}) {
  const t = socialText(locale).posts;
  return (
    <fieldset className="settings-rows">
      <legend>{t.when}</legend>
      <Field>
        <FieldLabel htmlFor="social-post-date">{t.date}</FieldLabel>
        <Input
          id="social-post-date"
          type="date"
          value={date}
          disabled={disabled}
          onChange={(e) => onChange({ date: e.target.value, time })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="social-post-time">{t.time}</FieldLabel>
        <Input
          id="social-post-time"
          type="time"
          value={time}
          disabled={disabled}
          onChange={(e) => onChange({ date, time: e.target.value })}
        />
      </Field>
      <p className="field-hint">{t.zone(timeZone)}</p>
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          {error.choices?.map((choice) => (
            <Button key={choice.label} type="button" size="sm" variant="outline" onClick={() => onChoice(choice)}>
              {choice.label}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
