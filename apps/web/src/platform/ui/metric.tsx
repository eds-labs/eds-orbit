// One figure of a module overview's metrics strip (.metrics-strip): an icon,
// a label, the amount ("—" while unknown) and an optional detail line.
import type { LucideIcon } from "lucide-react";

export function Metric({
  icon: Icon,
  label,
  amount,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  amount: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">
        <Icon aria-hidden />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{amount}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}
