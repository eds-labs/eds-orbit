// One figure of a module overview's metrics strip (.metrics-strip): an icon,
// a label, the amount ("—" while unknown) and an optional detail line. A
// `tone` ("warning") colours the figure; an `href` makes the whole tile a link.
import type { LucideIcon } from "lucide-react";
import { AppLink } from "./app-link";

export function Metric({
  icon: Icon,
  label,
  amount,
  detail,
  tone,
  href,
}: {
  icon: LucideIcon;
  label: string;
  amount: string;
  detail?: string;
  tone?: "warning";
  href?: string;
}) {
  const body = (
    <>
      <span className="metric-icon">
        <Icon aria-hidden />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{amount}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </>
  );
  return href ? (
    <AppLink className="metric metric-link" href={href} data-tone={tone}>
      {body}
    </AppLink>
  ) : (
    <div className="metric" data-tone={tone}>
      {body}
    </div>
  );
}
