export function missionFactKeys(mission: Record<string, unknown>) {
  if (typeof mission.chatProposalId !== "string") return undefined;
  const topics = mission.allowedTopics;
  if (!Array.isArray(topics)) return undefined;
  const keys = topics.filter(
    (topic): topic is string =>
      typeof topic === "string" &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(topic),
  );
  return keys.length ? [...new Set(keys)] : undefined;
}
