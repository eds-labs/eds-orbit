import { constantEqual, DomainError } from "../../../shared.ts";
import {
  callbackMac,
  compactUuid,
  expandUuid,
} from "../../../platform/connections/telegram.ts";
import type { TelegramCallback } from "../../../platform/connections/types.ts";
import { vetoPublication } from "./veto.ts";

/**
 * The Stop button of an assignment post preview (spec §9, Task 13), as
 * marketing's callback of the owner's Telegram bot (WP2.5a). The data format
 * is unchanged, so buttons sent before the move keep working:
 * `stop:<publication id, 22 chars>.<version>.<HMAC("id:version")>`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEXT = {
  stopped: "Gestoppt. Der Beitrag geht nicht raus.",
  handedOver:
    "Schon an Postiz übergeben. Entfernen ist nur noch in Postiz möglich.",
  notFound: "Beitrag nicht gefunden.",
  changed: "Beitrag wurde geändert. Bitte in Orbit stoppen.",
  noAccess: "Keine Berechtigung mehr für dieses Projekt.",
};

/** Callback data for the Stop button of a preview; at most 64 bytes. */
export function stopCallbackData(publicationId: string, version: number) {
  if (
    !UUID.test(publicationId) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 999_999_999
  )
    throw new DomainError("INVALID_PUBLICATION");
  const id = publicationId.toLowerCase();
  return `stop:${compactUuid(id)}.${version}.${callbackMac(`${id}:${version}`)}`;
}

function readStop(value: string) {
  const match =
    /^stop:([A-Za-z0-9_-]{22})\.([1-9]\d{0,8})\.([A-Za-z0-9_-]{22})$/.exec(
      value,
    );
  const id = match ? expandUuid(match[1]!) : null;
  if (!match || !id) return null;
  const version = Number(match[2]);
  return constantEqual(match[3]!, callbackMac(`${id}:${version}`))
    ? { publicationId: id, version }
    : null;
}

/** Withdraws the post before handoff; repeated clicks give the same answer. */
export const stopCallback: TelegramCallback = async (tx, actor, value) => {
  const stop = readStop(value);
  if (!stop) return null;
  try {
    const { result } = await vetoPublication(
      tx,
      actor,
      stop.publicationId,
      stop.version,
      "telegram",
    );
    return {
      handled: "stop_" + result,
      answer:
        result === "vetoed"
          ? TEXT.stopped
          : result === "already_handed_over"
            ? TEXT.handedOver
            : TEXT.notFound,
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === "VERSION_CONFLICT")
      return { handled: "stop_version_conflict", answer: TEXT.changed };
    if (error instanceof DomainError && error.status === 403)
      return { handled: "stop_forbidden", answer: TEXT.noAccess };
    throw error;
  }
};
