const generationProvenance = ["model", "usage", "jobId"] as const;

/**
 * Carry the generation provenance of the previous content version into an
 * edited version; the edit itself is recorded by the entity version history.
 */
export function withGenerationProvenance(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  return {
    ...next,
    ...Object.fromEntries(
      generationProvenance
        .filter((key) => previous[key] !== undefined)
        .map((key) => [key, previous[key]]),
    ),
  };
}
