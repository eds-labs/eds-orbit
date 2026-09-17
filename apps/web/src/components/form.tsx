"use client";
import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import {
  Alert,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from "./ui/primitives";
import type { Text } from "@/lib/i18n";
export type FormField = {
  name: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "password"
    | "number"
    | "datetime-local"
    | "url"
    | "textarea"
    | "select"
    | "checkbox";
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  value?: string | number | boolean;
  hint?: string;
  min?: number;
  max?: number;
  step?: string;
  placeholder?: string;
  showWhen?: { name: string; values: string[] };
};
export type FormValues = Record<string, string | boolean>;
export function DataForm({
  fields,
  onSubmit,
  pending,
  error,
  submitLabel = "Save",
  onCancel,
  t,
}: {
  fields: FormField[];
  onSubmit: (values: FormValues) => void | Promise<void>;
  pending: boolean;
  error?: string | null;
  submitLabel?: string;
  onCancel?: () => void;
  t?: Text;
}) {
  const [invalid, setInvalid] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields
        .filter((f) => f.type === "select")
        .map((f) => [f.name, String(f.value ?? "")]),
    ),
  );
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setInvalid(false);
    const f = new FormData(e.currentTarget),
      values: FormValues = {};
    for (const field of fields)
      values[field.name] =
        field.type === "checkbox"
          ? f.has(field.name)
          : String(f.get(field.name) || "");
    void onSubmit(values);
  }
  return (
    <form onSubmit={submit} onInvalid={() => setInvalid(true)}>
      <FieldGroup>
        {fields
          .filter(
            (field) =>
              !field.showWhen ||
              field.showWhen.values.includes(
                selected[field.showWhen.name] || "",
              ),
          )
          .map((field) => (
            <Field
              key={field.name}
              data-invalid={invalid || undefined}
              className={field.type === "checkbox" ? "field-check" : ""}
            >
              <FieldLabel htmlFor={`form-${field.name}`}>
                {field.label}
                {field.required && <span aria-hidden="true"> *</span>}
              </FieldLabel>
              {field.type === "textarea" ? (
                <Textarea
                  id={`form-${field.name}`}
                  name={field.name}
                  defaultValue={String(field.value ?? "")}
                  required={field.required}
                  placeholder={field.placeholder}
                  minLength={field.min}
                  maxLength={field.max}
                />
              ) : field.type === "select" ? (
                <select
                  className="input"
                  id={`form-${field.name}`}
                  name={field.name}
                  defaultValue={String(field.value ?? "")}
                  required={field.required}
                  onChange={(event) =>
                    setSelected((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                >
                  {!field.value && (
                    <option value="">
                      {field.required ? t?.("required") || "Select…" : "—"}
                    </option>
                  )}
                  {field.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "checkbox" ? (
                <Input
                  id={`form-${field.name}`}
                  type="checkbox"
                  name={field.name}
                  defaultChecked={Boolean(field.value)}
                  required={field.required}
                />
              ) : (
                <Input
                  id={`form-${field.name}`}
                  type={field.type || "text"}
                  name={field.name}
                  defaultValue={
                    typeof field.value === "boolean" ? "" : field.value
                  }
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  placeholder={field.placeholder}
                  autoComplete={
                    field.type === "password"
                      ? "new-password"
                      : field.type === "email"
                        ? "email"
                        : "off"
                  }
                />
              )}{" "}
              {field.hint && <p className="field-hint">{field.hint}</p>}
            </Field>
          ))}
      </FieldGroup>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-actions">
        {onCancel && (
          <Button variant="outline" type="button" onClick={onCancel}>
            {t?.("cancel") || "Cancel"}
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending && (
            <LoaderCircle className="spin" data-icon="inline-start" />
          )}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
export const str = (v: FormValues, key: string) => String(v[key] ?? "").trim();
export const num = (v: FormValues, key: string) => Number(v[key]);
export const iso = (v: FormValues, key: string) =>
  new Date(str(v, key)).toISOString();
export const csv = (v: FormValues, key: string) =>
  str(v, key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const dateField = (
  name: string,
  label: string,
  required = true,
): FormField => ({ name, label, type: "datetime-local", required });
export const options = (values: string[]) =>
  values.map((value) => ({ value, label: value.replaceAll("_", " ") }));
