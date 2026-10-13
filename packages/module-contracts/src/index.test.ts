import { describe, expect, it } from "vitest";
import { RegistryError, validateRegistry, type ServerModule } from "./index.ts";

const module = (overrides: Partial<ServerModule>): ServerModule => ({
  id: "alpha",
  version: "1.0.0",
  displayName: { en: "Alpha", de: "Alpha" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [],
  tables: [],
  permissions: [],
  ...overrides,
});
const platform = {
  entityKinds: [{ kind: "jobs", description: "Jobs" }],
  tables: ["Entity"],
};
const problems = (modules: ServerModule[]) => {
  try {
    validateRegistry(modules, platform);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    return (error as RegistryError).problems;
  }
};

describe("validateRegistry", () => {
  it("accepts a valid registry and orders modules after their dependencies", () => {
    const registry = validateRegistry(
      [
        module({
          id: "marketing",
          dependsOn: ["knowledge"],
          entityKinds: [{ kind: "missions", description: "m" }],
          tables: ["Profile"],
        }),
        module({
          id: "knowledge",
          entityKinds: [{ kind: "sources", description: "s" }],
        }),
      ],
      platform,
    );
    expect(registry.order).toEqual(["knowledge", "marketing"]);
    expect(Object.fromEntries(registry.kindOwner)).toEqual({
      jobs: "platform",
      sources: "knowledge",
      missions: "marketing",
    });
    expect(Object.fromEntries(registry.tableOwner)).toEqual({
      Entity: "platform",
      Profile: "marketing",
    });
  });

  it("lists the kinds the project export leaves out, platform first", () => {
    const registry = validateRegistry(
      [
        module({
          entityKinds: [
            { kind: "secret_rows", description: "s", exported: false },
            { kind: "plain_rows", description: "p" },
          ],
        }),
      ],
      {
        entityKinds: [
          { kind: "jobs", description: "j" },
          { kind: "tokens", description: "t", exported: false },
        ],
        tables: [],
      },
    );
    expect(registry.unexportedKinds).toEqual(["tokens", "secret_rows"]);
    expect(
      problems([
        module({
          entityKinds: [
            { kind: "rows", description: "r", exported: true as never },
          ],
        }),
      ])[0],
    ).toMatch(/exported/);
  });

  it("refuses invalid manifests, duplicate and reserved ids", () => {
    expect(problems([module({ id: "Bad-Id" })])[0]).toMatch(/^Bad-Id: id /);
    expect(problems([module({ version: "1" })])[0]).toMatch(/version/);
    expect(problems([module({}), module({})])).toContain(
      "duplicate module id alpha",
    );
    expect(problems([module({ id: "platform" })])).toContain(
      "module id platform is reserved",
    );
  });

  it("refuses unknown, self and cyclic dependencies", () => {
    expect(problems([module({ dependsOn: ["missing"] })])).toContain(
      "alpha depends on unknown module missing",
    );
    expect(problems([module({ dependsOn: ["alpha"] })])).toContain(
      "alpha depends on itself",
    );
    expect(
      problems([
        module({ id: "one", dependsOn: ["two"] }),
        module({ id: "two", dependsOn: ["one"] }),
      ]),
    ).toContain("dependency cycle among one, two");
  });

  it("gives every entity kind, table and permission exactly one owner", () => {
    expect(
      problems([module({ entityKinds: [{ kind: "jobs", description: "j" }] })]),
    ).toContain("entity kind jobs claimed by platform and alpha");
    expect(
      problems([
        module({ entityKinds: [{ kind: "x_kind", description: "x" }] }),
        module({
          id: "beta",
          entityKinds: [{ kind: "x_kind", description: "x" }],
        }),
      ]),
    ).toContain("entity kind x_kind claimed by alpha and beta");
    expect(problems([module({ tables: ["Entity"] })])).toContain(
      "table Entity claimed by platform and alpha",
    );
    expect(
      problems([
        module({
          permissions: [
            { key: "beta.read", description: "r", defaultRoles: ["owner"] },
          ],
        }),
      ]),
    ).toContain("permission beta.read of alpha lacks the module prefix");
  });
});
