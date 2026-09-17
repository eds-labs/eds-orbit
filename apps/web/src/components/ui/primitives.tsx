"use client";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ComponentProps,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, Check, LoaderCircle, X, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
const buttonVariants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      outline: "button-outline",
      ghost: "button-ghost",
      destructive: "button-danger",
    },
    size: { default: "", sm: "button-sm", icon: "button-icon" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cn("input", props.className)} />;
}
export function Textarea(props: ComponentProps<"textarea">) {
  return (
    <textarea {...props} className={cn("input textarea", props.className)} />
  );
}
export function FieldGroup({ children }: { children: ReactNode }) {
  return (
    <div data-slot="field-group" className="field-group">
      {children}
    </div>
  );
}
export function Field({ children, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} data-slot="field" className={cn("field", props.className)}>
      {children}
    </div>
  );
}
export function FieldLabel(props: ComponentProps<"label">) {
  return <label {...props} className="field-label" />;
}
export function Alert({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "error" | "success" | "info" | "warning";
}) {
  return (
    <div
      className={cn("alert", `alert-${kind}`)}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "success" ? (
        <Check aria-hidden="true" />
      ) : (
        <AlertCircle aria-hidden="true" />
      )}
      <div>{children}</div>
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "blue";
}) {
  return <span className={cn("badge", `badge-${tone}`)}>{children}</span>;
}
export function Status({ value }: { value: unknown }) {
  const s = String(value ?? "unknown");
  return (
    <Badge
      tone={
        /failed|revoked|conflict|expired|blocked|insufficient/.test(s)
          ? "danger"
          : /not_ready|not_configured|unknown|paused/.test(s)
            ? "neutral"
            : /complete|ready|verified|approved|active|success/.test(s)
              ? "success"
              : /pending|candidate|draft|review|observe/.test(s)
                ? "warning"
                : "neutral"
      }
    >
      {s.replaceAll("_", " ")}
    </Badge>
  );
}
export function Skeleton() {
  return <div className="skeleton" aria-hidden="true" />;
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle aria-hidden="true" className="spin" />
      <p>{label}</p>
      <Skeleton />
      <Skeleton />
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  icon?: typeof Inbox;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.showModal();
    const el = ref.current;
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={cn("modal", wide && "modal-wide")}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.key}
          ref={(node) => {
            refs.current[i] = node;
          }}
          role="tab"
          aria-selected={value === tab.key}
          tabIndex={value === tab.key ? 0 : -1}
          className={cn("tab", value === tab.key && "tab-active")}
          onClick={() => onChange(tab.key)}
          onKeyDown={(e) => {
            let j: number | undefined;
            if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
            if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
            if (e.key === "Home") j = 0;
            if (e.key === "End") j = tabs.length - 1;
            if (j !== undefined) {
              e.preventDefault();
              onChange(tabs[j].key);
              refs.current[j]?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
export function DataList({
  items,
  render,
  empty = "No entries yet.",
}: {
  items: unknown[];
  render: (item: unknown, i: number) => ReactNode;
  empty?: string;
}) {
  return items.length ? (
    <div className="data-list">{items.map(render)}</div>
  ) : (
    <Empty title={empty} />
  );
}
