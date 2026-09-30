export function missionFactKeys(mission: Record<string, unknown>) {
  // Confirmed Chat proposals and planned autopilot slots carry exact keys.
  if (typeof mission.chatProposalId !== "string" && mission.autopilot !== true)
    return undefined;
  const confirmed = Array.isArray(mission.factKeys)
    ? mission.factKeys.filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      )
    : [];
  if (confirmed.length) return [...new Set(confirmed)];
  const topics = mission.allowedTopics;
  if (!Array.isArray(topics)) return undefined;
  const keys = topics.filter(
    (topic): topic is string =>
      typeof topic === "string" &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(topic),
  );
  return keys.length ? [...new Set(keys)] : undefined;
}
