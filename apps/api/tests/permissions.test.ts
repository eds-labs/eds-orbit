import { describe, expect, it } from "vitest";
import {
  actionPermissions,
  authorize,
  can,
  platformActionPermissions,
  PROJECT_OWN,
  PROJECT_READ,
  PROJECT_WRITE,
} from "../src/platform/tenancy/permissions.ts";
import { registeredActionNames } from "../src/platform/modules/contributions.ts";
import { knowledgeActionPermissions } from "../src/modules/knowledge/permissions.ts";
import { marketingActionPermissions } from "../src/modules/marketing/permissions.ts";
import { moduleRegistry } from "../src/modules/registry.ts";

/** The permission catalogue (WP1.5): the three project levels reproduce the old role checks. */
describe("permission catalogue", () => {
  it("maps the project levels to the three roles", () => {
    const levels = {
      read: PROJECT_READ,
      write: PROJECT_WRITE,
      own: PROJECT_OWN,
    };
    const allowed = Object.fromEntries(
      Object.entries(levels).map(([name, permission]) => [
        name,
        (["owner", "editor", "viewer"] as const).filter((role) =>
          can({ role }, permission),
        ),
      ]),
    );
    expect(allowed).toEqual({
      read: ["owner", "editor", "viewer"],
      write: ["owner", "editor"],
      own: ["owner"],
    });
  });

  it("keeps the caller's error code and status", () => {
    expect(() => authorize({ role: "owner" }, PROJECT_OWN)).not.toThrow();
    expect(() =>
      authorize({ role: "editor" }, PROJECT_OWN, "OWNER_REQUIRED"),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED", status: 403 }));
    expect(() => authorize({ role: "viewer" }, PROJECT_WRITE)).toThrow(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });

  it("names action permissions after module and action", () => {
    const built = actionPermissions("demo", {
      owner: ["do-it"],
      write: ["edit"],
      read: ["look"],
    });
    expect(
      Object.fromEntries(
        Object.entries(built).map(([k, v]) => [k, [v.key, v.defaultRoles]]),
      ),
    ).toEqual({
      "do-it": ["demo.action.do_it", ["owner"]],
      edit: ["demo.action.edit", ["owner", "editor"]],
      look: ["demo.action.look", ["owner", "editor", "viewer"]],
    });
  });

  it("gives every registered action exactly one module's permission", () => {
    // The registered handlers (WP2.1f; before, the server.ts if-chain).
    const dispatched = new Set(registeredActionNames());
    const catalogues = [
      platformActionPermissions,
      knowledgeActionPermissions,
      marketingActionPermissions,
    ];
    const declared = catalogues.flatMap((c) => Object.keys(c));
    expect(declared.length).toBe(new Set(declared).size);
    expect([...dispatched].filter((a) => !declared.includes(a)).sort()).toEqual(
      [],
    );
    expect(declared.filter((a) => !dispatched.has(a)).sort()).toEqual([]);
  });

  it("registers every permission key once (registry validation)", () => {
    expect(() => moduleRegistry()).not.toThrow();
  });
});
