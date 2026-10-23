"use client";
// Postiz channel assignment for the project (WP2.3b), moved unchanged from components/management.tsx.
import { useState } from "react";
import { action, useMutation, value, type Entity } from "@/lib/api";
import { Alert, Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
export function PostizChannelAssignment({ connector }: { connector: Entity }) {
  const { project, locale, refresh } = useWorkspace();
  // Bound to an organization connection: the organization assigns channels.
  const central = Boolean(connector.data.centralConnectionId);
  const own = (key: string) =>
    Array.isArray(connector.data[key])
      ? (connector.data[key] as unknown[]).map(String)
      : [];
  const assigned = central
    ? own("allowedChannelIds")
    : own("assignedIntegrationIds");
  const [selected, setSelected] = useState<string[]>(assigned);
  const savedLong = Array.isArray(connector.data.xLongPostIntegrationIds)
    ? connector.data.xLongPostIntegrationIds.map(String)
    : [];
  const [longPosts, setLongPosts] = useState<string[]>(savedLong);
  const savedTimes: Record<string, string> =
    connector.data.postingTimes &&
    typeof connector.data.postingTimes === "object"
      ? (connector.data.postingTimes as Record<string, string>)
      : {};
  const [times, setTimes] = useState<Record<string, string>>(savedTimes);
  const effectiveTimes = Object.fromEntries(
    Object.entries(times).filter(
      ([id, time]) =>
        selected.includes(id) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
    ),
  );
  const mutation = useMutation(refresh);
  const channels = Array.isArray(connector.data.channels)
    ? (connector.data.channels as Record<string, unknown>[])
    : [];
  const effectiveLong = longPosts.filter((id) => selected.includes(id));
  const changed =
    JSON.stringify([...selected].sort()) !==
      JSON.stringify([...assigned].sort()) ||
    JSON.stringify([...effectiveLong].sort()) !==
      JSON.stringify([...savedLong].sort()) ||
    JSON.stringify(Object.entries(effectiveTimes).sort()) !==
      JSON.stringify(Object.entries(savedTimes).sort());
  return (
    <div className="postiz-assignment">
      <strong>
        {locale === "de"
          ? `Kanäle für ${project.name}`
          : `Channels for ${project.name}`}
      </strong>
      <p>
        {locale === "de"
          ? "Nur ausdrücklich zugeordnete Konten können für dieses Projekt ausgewählt, verifiziert oder veröffentlicht werden."
          : "Only explicitly assigned accounts can be selected, verified, or published for this project."}
        {central &&
          (locale === "de"
            ? " Die Kanäle weist die Organisation in ihren Einstellungen zu."
            : " The organization assigns the channels in its settings.")}
      </p>
      {channels.map((channel) => {
        const id = String(channel.id);
        return (
          <div key={id} className="postiz-assignment-channel">
            <label>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                disabled={
                  central || Boolean(channel.disabled) || mutation.pending
                }
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, id]
                      : current.filter((value) => value !== id),
                  )
                }
              />
              <span>
                {String(channel.name || id)} ·{" "}
                {String(channel.identifier || "unknown")} <small>({id})</small>
              </span>
            </label>
            {selected.includes(id) && (
              <label className="postiz-assignment-option">
                <span>
                  {locale === "de"
                    ? "Feste Uhrzeit pro Tag"
                    : "Daily posting time"}
                </span>
                <input
                  type="time"
                  value={times[id] ?? ""}
                  disabled={mutation.pending}
                  onChange={(event) =>
                    setTimes((current) => {
                      const next = { ...current };
                      if (event.target.value) next[id] = event.target.value;
                      else delete next[id];
                      return next;
                    })
                  }
                />
              </label>
            )}
            {channel.identifier === "x" && selected.includes(id) && (
              <label className="postiz-assignment-option">
                <input
                  type="checkbox"
                  checked={longPosts.includes(id)}
                  disabled={mutation.pending}
                  onChange={(event) =>
                    setLongPosts((current) =>
                      event.target.checked
                        ? [...current, id]
                        : current.filter((value) => value !== id),
                    )
                  }
                />
                <span>
                  {locale === "de"
                    ? "X Premium: lange Posts (bis 4.000 Zeichen)"
                    : "X Premium: long posts (up to 4,000 characters)"}
                </span>
              </label>
            )}
          </div>
        );
      })}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || mutation.pending}
        onClick={() =>
          mutation.run(() =>
            action(project.id, "postiz-assign-channels", {
              connectorId: connector.id,
              version: connector.version,
              integrationIds: selected,
              xLongPostIntegrationIds: effectiveLong,
              postingTimes: effectiveTimes,
            }),
          )
        }
      >
        {locale === "de" ? "Zuordnung speichern" : "Save assignment"}
      </Button>
    </div>
  );
}
