"use client";
import type { Entity } from "@/lib/api";
import {
  ExperimentControls,
  MemoryLifecycleControls,
  MetricCorrection,
} from "./lifecycle";
import { PreferenceActions } from "./advanced";

/**
 * Marketing's controls in the record dialog (WP2.3b), moved unchanged from
 * RecordDetail: preferences, experiments, memory and metric corrections.
 */
export function marketingRecordActions(
  current: Entity,
  update: (entity: Entity) => void,
  close: () => void,
) {
  return (
    <>
      {current.kind === "preferences" || current.kind === "preference" ? (
        <PreferenceActions entity={current} onDone={close} />
      ) : null}
      {current.kind === "experiments" && (
        <ExperimentControls entity={current} onUpdate={update} />
      )}
      {["preferences", "insights"].includes(current.kind) && (
        <MemoryLifecycleControls entity={current} onDone={close} />
      )}
      {current.kind === "metrics" && (
        <MetricCorrection entity={current} onDone={close} />
      )}
    </>
  );
}
