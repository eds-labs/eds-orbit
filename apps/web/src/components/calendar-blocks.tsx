"use client";
import { useState } from "react";
import { action, useMutation, value, when, type Entity } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "./ui/primitives";
import { DataForm, csv, dateField, iso, str } from "./form";
import { useWorkspace } from "./workspace-context";
export function calendarBlockConflicts(block: Entity, content: Entity) {
  const b = block.data,
    c = content.data;
  const channels = Array.isArray(b.channels) ? b.channels : [];
  return (
    b.status === "active" &&
    (!channels.length || channels.includes(c.channel)) &&
    Date.parse(String(c.scheduledAt)) >= Date.parse(String(b.startAt)) &&
    Date.parse(String(c.scheduledAt)) < Date.parse(String(b.endAt))
  );
}
export function CalendarBlocks({ items }: { items: Entity[] }) {
  const { project, isOwner, locale, refresh } = useWorkspace();
  const [add, setAdd] = useState(false);
  const mutation = useMutation(refresh);
  const active = items.filter((b) => b.data.status === "active");
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Manual calendar blocks</h2>
          <p>
            Blocks are checked again before publishing. Releasing a block does
            not restore stale approvals.
          </p>
        </div>
        {isOwner && (
          <Button variant="outline" onClick={() => setAdd(true)}>
            Add calendar block
          </Button>
        )}
      </div>
      {active.length ? (
        active.map((b) => (
          <div className="data-row calendar-block-row" key={b.id}>
            <div>
              <strong>{value(b, "title")}</strong>
              <p>
                {when(b.data.startAt, locale, project.timezone)} —{" "}
                {when(b.data.endAt, locale, project.timezone)}
              </p>
              <p>{value(b, "reason")}</p>
              <small>
                {Array.isArray(b.data.channels) && b.data.channels.length
                  ? b.data.channels.join(", ")
                  : "All channels"}
              </small>
            </div>
            <Badge tone="warning">Blocked</Badge>
            {isOwner && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    action(project.id, "calendar-unblock", {
                      blockId: b.id,
                      version: b.version,
                    }),
                  )
                }
              >
                Release block
              </Button>
            )}
          </div>
        ))
      ) : (
        <p className="panel-note">
          No manual blocks. Policy quotas, spacing and quiet hours still apply.
        </p>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {add && (
        <Modal title="Add calendar block" onClose={() => setAdd(false)}>
          <DataForm
            fields={[
              { name: "title", label: "Block title", required: true, max: 160 },
              {
                name: "channels",
                label: "Channels, comma separated (empty means all)",
              },
              dateField("startAt", "Block starts (browser local time)"),
              dateField("endAt", "Block ends (browser local time)"),
              {
                name: "reason",
                label: "Reason",
                type: "textarea",
                required: true,
                max: 500,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Block this interval"
            onCancel={() => setAdd(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "calendar-block", {
                    title: str(v, "title"),
                    channels: csv(v, "channels"),
                    startAt: iso(v, "startAt"),
                    endAt: iso(v, "endAt"),
                    reason: str(v, "reason"),
                  }),
                )
                .then((r) => {
                  if (r) setAdd(false);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
