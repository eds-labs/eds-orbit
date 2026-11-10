/**
 * Triggerable events (ADR 0021, plan §2.7): the module-declared event types
 * a configured agent may be started by. Only declared, published types of
 * an available module count; the trigger subscriber (WP1.7) and the
 * definition check read the same declarations.
 */
import {
  moduleAvailable,
  registeredTriggerableEvents,
} from "../../modules/contributions.ts";

/** The declaration of a triggerable event type, or undefined. */
export function triggerableEvent(type: string) {
  const declared = registeredTriggerableEvents().get(type);
  return declared && (declared.module === "platform" || moduleAvailable(declared.module))
    ? declared
    : undefined;
}

/** Every triggerable event type of available modules, for the builder. */
export function triggerableEvents() {
  return [...registeredTriggerableEvents()]
    .filter(([, d]) => d.module === "platform" || moduleAvailable(d.module))
    .map(([type, d]) => ({
      type,
      module: d.module,
      title: d.title,
      subject: d.subject,
      sensitive: d.sensitive === true,
    }));
}
