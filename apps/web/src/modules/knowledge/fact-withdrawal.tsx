"use client";
// Withdrawing a verified fact (WP2.3b), moved unchanged from components/operator-tools.tsx.
import { useState } from "react";
import { action, useMutation, type Entity } from "@/lib/api";
import { Alert, Button } from "@/components/ui/primitives";
import { DataForm } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
export function FactWithdrawal({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const { project, isOwner, refresh } = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    onDone();
  });
  if (
    !isOwner ||
    ["revoked", "withdrawn", "superseded"].includes(String(entity.data.status))
  )
    return null;
  return (
    <div>
      {!confirm ? (
        <Button variant="outline" onClick={() => setConfirm(true)}>
          Withdraw fact
        </Button>
      ) : (
        <>
          <Alert kind="warning">
            Withdraw this exact fact version and invalidate dependent evidence
            and content. The history remains available.
          </Alert>
          <DataForm
            fields={[
              {
                name: "confirm",
                label: "Withdraw this fact from future use",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Withdraw version"
            onCancel={() => setConfirm(false)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action(project.id, "withdraw-fact", {
                    factId: entity.id,
                    version: entity.version,
                  }),
                )
                .then(() => {})
            }
          />
        </>
      )}
    </div>
  );
}
