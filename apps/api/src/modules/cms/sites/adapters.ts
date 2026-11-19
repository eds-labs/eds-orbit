import { z } from "zod";

// How a site receives content and hears about changes (ADR 0029 §2.1, §3.2,
// CH1.11). The adapter decides how content reaches the site: `orbit_pull`
// sites read the live revision through the delivery API, so publishing is
// the pointer switch in Orbit. Push adapters (WordPress and others, phase 3)
// will write to the site and use the publication states `sending`,
// `outcome_unknown` and reconciliation; their kinds are named here so stored
// sites never meet an unknown kind, but they cannot be chosen yet.
//
// Notifiers tell a site that something changed: `webhook` sends the signed
// platform webhook (CH1.3) to one endpoint; the rebuild notifiers for static
// sites (Coolify deploy, GitHub repository_dispatch) arrive with phase 2
// (decision E-1) and cannot be chosen yet.

export interface AdapterCapabilities {
  /** `pull`: the site reads Orbit; `push`: Orbit writes to the site. */
  delivery: "pull" | "push";
  /** Orbit can confirm the live page shows the revision (live check). */
  liveCheck: boolean;
}

export interface PublishingAdapter {
  kind: string;
  /** False: named for stored data and later phases, refused on save. */
  available: boolean;
  capabilities: AdapterCapabilities;
  /** The adapter's own settings on the site (`adapterConfig`). */
  config: z.ZodType<Record<string, unknown>>;
}

/** Settings of a pull site: whether and how Orbit checks the live page. */
export const pullConfig = z
  .object({
    /** Check the canonical page after a publication (needs the revision meta tag). */
    liveCheck: z.boolean().default(false),
    /** The `<meta name="…">` the site renders with the live revision id or number. */
    revisionMeta: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,40}$/)
      .default("orbit-revision"),
    /**
     * Minutes after the publication of each live check; static sites that
     * rebuild need longer than ISR sites. The last miss needs a person.
     */
    liveCheckMinutes: z.array(z.int().min(1).max(1440)).min(1).max(10).default([1, 3, 10, 30, 60]),
    /**
     * The site's preview route (e.g. Next.js draft mode), called with
     * `?token=…&path=…`; null: previews give the token only (CH1.12).
     */
    previewPath: z
      .string()
      .regex(/^\/[a-z0-9/_-]{0,100}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type PullConfig = z.infer<typeof pullConfig>;

const ADAPTERS: PublishingAdapter[] = [
  { kind: "orbit_pull", available: true, capabilities: { delivery: "pull", liveCheck: true }, config: pullConfig },
  { kind: "wordpress", available: false, capabilities: { delivery: "push", liveCheck: true }, config: z.object({}).strict() },
];

export const adapterFor = (kind: string) => ADAPTERS.find((a) => a.kind === kind) ?? null;
export const adapterCatalog = () =>
  ADAPTERS.map(({ kind, available, capabilities }) => ({ kind, available, capabilities }));

/** The site's pull settings with defaults (stored settings may predate a field). */
export const pullSettings = (adapterConfig: unknown): PullConfig => {
  const parsed = pullConfig.safeParse(adapterConfig ?? {});
  return parsed.success ? parsed.data : pullConfig.parse({});
};

// --- Notifiers ----------------------------------------------------------------

export const webhookNotifier = z.object({ kind: z.literal("webhook"), endpointId: z.uuid() }).strict();
export const coolifyNotifier = z.object({ kind: z.literal("coolify_rebuild"), connectionId: z.uuid() }).strict();
export const githubNotifier = z
  .object({ kind: z.literal("github_dispatch"), connectionId: z.uuid(), eventType: z.string().regex(/^[a-z0-9_.-]{1,60}$/) })
  .strict();

export const notifierInput = z.discriminatedUnion("kind", [webhookNotifier, coolifyNotifier, githubNotifier]);
export type Notifier = z.infer<typeof notifierInput>;

const NOTIFIERS: Array<{ kind: Notifier["kind"]; available: boolean }> = [
  { kind: "webhook", available: true },
  { kind: "coolify_rebuild", available: false },
  { kind: "github_dispatch", available: false },
];
export const notifierAvailable = (kind: string) => NOTIFIERS.find((n) => n.kind === kind)?.available ?? false;
export const notifierCatalog = () => NOTIFIERS.map((n) => ({ ...n }));

/** The site's stored notifiers that still parse (unknown shapes are ignored). */
export const storedNotifiers = (raw: unknown): Notifier[] =>
  (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const parsed = notifierInput.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
