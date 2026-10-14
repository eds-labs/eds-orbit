"use client";
import { useState } from "react";
import { action, post, useMutation, value } from "@/lib/api";
import { Button, Modal } from "./ui/primitives";
import { DataForm, options, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";

export function WorkspacePause() {
  const { project, identity, isOwner, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  const workspace = identity.workspaces.find(
    (w) => w.id === project.workspaceId,
  );
  if (!isOwner || workspace?.role !== "owner") return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          mutation.clear();
        }}
      >
        Workspace execution
      </Button>
      {open && (
        <Modal
          title="Workspace execution"
          description={`This affects every project in ${workspace.name}. Queued work rechecks the current policy and source rights.`}
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "paused",
                label: "Workspace action",
                type: "select",
                required: true,
                options: [
                  { value: "true", label: "Pause all workspace projects" },
                  { value: "false", label: "Resume all workspace projects" },
                ],
              },
              {
                name: "confirm",
                label: "Apply this action to every project in this workspace",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Apply workspace action"
            onSubmit={(v) =>
              mutation
                .run(() =>
                  post(
                    `/workspaces/${encodeURIComponent(project.workspaceId)}/pause`,
                    { paused: str(v, "paused") === "true" },
                  ),
                )
                .then((r) => {
                  if (r) setOpen(false);
                })
            }
          />
        </Modal>
      )}
    </>
  );
}
