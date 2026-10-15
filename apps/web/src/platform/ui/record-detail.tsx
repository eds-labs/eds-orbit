"use client";
// Details of one record of any kind (WP2.3b), moved unchanged from components/management.tsx.
import { useState, type ReactNode } from "react";
import { value, type Entity } from "@/lib/api";
import { Badge, Modal, Status } from "@/components/ui/primitives";
/**
 * `actions` renders the owning module's controls for the record (WP2.3b),
 * with the record as currently shown, a setter for an updated version and
 * a way to close the dialog.
 */
export function RecordDetail({
  entity,
  onClose,
  actions,
}: {
  entity: Entity;
  onClose: () => void;
  actions?: (
    current: Entity,
    update: (entity: Entity) => void,
    close: () => void,
  ) => ReactNode;
}) {
  const [current, setCurrent] = useState(entity);
  return (
    <Modal
      title={value(current, "name", value(current, "title", current.kind))}
      onClose={onClose}
      wide
    >
      <div className="detail-summary">
        <Status value={current.data.status} />
        <Badge>Version {current.version}</Badge>
      </div>
      <dl className="record-detail">
        {Object.entries(current.data)
          .filter(
            ([key]) =>
              !["credential", "secret", "token", "password"].some((k) =>
                key.toLowerCase().includes(k),
              ),
          )
          .map(([key, v]) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
              <dd>
                {v === null ? (
                  "Not available"
                ) : typeof v === "object" ? (
                  <pre>{JSON.stringify(v, null, 2)}</pre>
                ) : (
                  String(v)
                )}
              </dd>
            </div>
          ))}
      </dl>
      {actions?.(current, setCurrent, onClose)}
    </Modal>
  );
}
