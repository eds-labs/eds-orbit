// Environment names that give a process a paid AI provider: the provider
// keys and the model, price and image route variables (OPENAI_*, ANTHROPIC_*).
const PROVIDER_ACCESS = /^(OPENAI|ANTHROPIC)_/;

/**
 * Removes every AI provider key and model or image route variable from
 * `env` (R62): a process started with it cannot reach a paid provider
 * through its environment. Returns the names removed.
 */
export function clearProviderAccess(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const removed = Object.keys(env).filter((name) => PROVIDER_ACCESS.test(name));
  for (const name of removed) delete env[name];
  return removed;
}
