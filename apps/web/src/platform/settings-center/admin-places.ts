// The table from an old administration address to its system section. It
// lives in its own file so the system sections can name their links from it
// (sections/system.tsx) while the redirect table (redirects.ts) imports those
// sections: a shared list without an import cycle.

// /admin/<section> → system area and rest. Only users and organizations
// take an id, as their center sections do; the old shell shows any other
// section and ignores an id below it, so that id is dropped.
export const ADMIN: ReadonlyMap<string, { area: string; rest: string[]; takesId?: true }> =
  new Map([
    ["", { area: "overview", rest: [] }],
    ["integrations", { area: "integrations", rest: [] }],
    ["ai", { area: "ai", rest: [] }],
    ["mcp", { area: "mcp", rest: [] }],
    ["audit", { area: "security", rest: ["audit"] }],
    ["users", { area: "users", rest: [], takesId: true }],
    ["invitations", { area: "users", rest: ["invitations"] }],
    ["organizations", { area: "organizations", rest: [], takesId: true }],
    ["projects", { area: "organizations", rest: ["projects"] }],
  ]);
