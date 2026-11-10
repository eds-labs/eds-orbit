"use client";
import { useId, useState } from "react";
import { action, useMutation, value, when, type Entity } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { DataForm, csv, dateField, iso, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { marketingText } from "./labels";
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
/**
 * The owner's blocked periods on the editorial plan (stored as
 * `calendar_blocks`): no content is published inside one.
 */
export function CalendarBlocks({ items }: { items: Entity[] }) {
  const { project, isOwner, locale, t, refresh } = useWorkspace();
  const words = marketingText(locale).blocks;
  const headingId = useId();
  const [add, setAdd] = useState(false);
  const mutation = useMutation(refresh);
  const active = items.filter((b) => b.data.status === "active");
  return (
    <section
      className="panel administration-panel"
      aria-labelledby={headingId}
    >
      <div className="panel-head">
        <div>
          <h2 id={headingId}>{words.heading}</h2>
          <p>{words.intro}</p>
        </div>
        {isOwner && (
          <Button variant="outline" onClick={() => setAdd(true)}>
            {words.add}
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
                  : words.allChannels}
              </small>
            </div>
            <Badge tone="warning">{words.blocked}</Badge>
            {isOwner && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                aria-label={words.releaseLabel(value(b, "title"))}
                onClick={() =>
                  mutation.run(() =>
                    action(project.id, "calendar-unblock", {
                      blockId: b.id,
                      version: b.version,
                    }),
                  )
                }
              >
                {words.release}
              </Button>
            )}
          </div>
        ))
      ) : (
        <p className="panel-note">{words.empty}</p>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {add && (
        <Modal title={words.add} onClose={() => setAdd(false)}>
          <DataForm
            fields={[
              { name: "title", label: words.title, required: true, max: 160 },
              { name: "channels", label: words.channels },
              dateField("startAt", words.startAt),
              dateField("endAt", words.endAt),
              {
                name: "reason",
                label: words.reason,
                type: "textarea",
                required: true,
                max: 500,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel={words.submit}
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
