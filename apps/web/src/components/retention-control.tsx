"use client";
// The project retention period (WP2.3b), moved unchanged from the marketing module (platform UI).
import { useState } from "react";
import { action } from "@/lib/api";
import { useMutation } from "@/lib/api";
import { Alert, Button, Modal } from "./ui/primitives";
import { DataForm, num } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
export function RetentionControl() {
  const { project, isOwner, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Memory retention</h2>
          <p>
            Delete old insights and expired editorial preferences within this
            project.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Review retention
        </Button>
      </div>
      {open && (
        <Modal
          title="Apply memory retention"
          description="This is a deletion action. It removes record text and previous versions, while keeping the audit identifier. Source documents and product facts are managed separately."
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "days",
                label: "Retain the last number of days",
                type: "number",
                required: true,
                min: 30,
                max: 3650,
              },
              {
                name: "confirm",
                label:
                  "I approve deleting older insights and expired preferences using this exact retention period.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Apply retention deletion"
            onCancel={() => setOpen(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "retention", { days: num(v, "days") }),
                )
                .then((r) => {
                  if (r) setOpen(false);
                })
            }
          />
        </Modal>
      )}
      {mutation.success && (
        <Alert kind="success">
          The retention operation was recorded for this project.
        </Alert>
      )}
    </section>
  );
}
